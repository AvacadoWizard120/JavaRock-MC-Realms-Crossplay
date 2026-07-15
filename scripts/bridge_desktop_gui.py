#!/usr/bin/env python3
"""Native desktop launcher for JavaRock."""

from __future__ import annotations

import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

try:
    import tkinter as tk
    from tkinter import ttk, messagebox, simpledialog
except ImportError as exc:  # pragma: no cover - depends on local Python install
    print(f"Tkinter is not available in this Python install: {exc}", file=sys.stderr)
    raise


PROJECT_ROOT = Path(__file__).resolve().parents[1]
PRIMARY_RUNTIME_DIR = PROJECT_ROOT / ".runtime"
FALLBACK_RUNTIME_DIR = PROJECT_ROOT / ".runtime-desktop"
AUTH_PROFILES_DIR = PROJECT_ROOT / ".auth-profiles"
AUTH_PROFILE_INDEX = AUTH_PROFILES_DIR / "profiles.json"


def can_write_dir(path: Path) -> bool:
    try:
        path.mkdir(parents=True, exist_ok=True)
        probe = path / f".write-test-{os.getpid()}-{time.time_ns()}.tmp"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        return True
    except OSError:
        return False


RUNTIME_DIR = PRIMARY_RUNTIME_DIR if can_write_dir(PRIMARY_RUNTIME_DIR) else FALLBACK_RUNTIME_DIR
RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
STATUS_FILE = RUNTIME_DIR / "bridge-status.json"
STDOUT_LOG = RUNTIME_DIR / "bridge-desktop-gui-bridge.out.log"
STDERR_LOG = RUNTIME_DIR / "bridge-desktop-gui-bridge.err.log"
GUI_PREFERENCES_FILE = RUNTIME_DIR / "bridge-desktop-gui-preferences.json"


REALM_LINE_RE = re.compile(
    r"^\s*\[(?P<index>\d+)\]\s+(?P<name>.*?)\s+\|\s+id=(?P<id>.*?)\s+\|\s+owner=(?P<owner>.*?)\s+\|\s+state=(?P<state>.*?)(?:\s+expired)?\s*$"
)
PROFILE_SAFE_RE = re.compile(r"[^a-zA-Z0-9_.-]+")


def powershell_exe() -> str:
    return "powershell.exe"


def read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_gui_preferences(dark_mode: bool) -> None:
    GUI_PREFERENCES_FILE.write_text(
        json.dumps({"darkMode": bool(dark_mode)}, indent=2),
        encoding="utf-8",
    )


def safe_profile_id(name: str) -> str:
    cleaned = PROFILE_SAFE_RE.sub("-", name.strip()).strip("-._").lower()
    return cleaned or "account"


def auth_profile_folder(profile_id: str) -> Path:
    return AUTH_PROFILES_DIR / safe_profile_id(profile_id)


def load_auth_profile_store() -> tuple[list[dict], str | None]:
    data = read_json(AUTH_PROFILE_INDEX)
    profiles: list[dict] = []
    seen: set[str] = set()
    for raw in data.get("profiles", []):
        if not isinstance(raw, dict):
            continue
        profile_id = safe_profile_id(str(raw.get("id") or raw.get("name") or "account"))
        if profile_id in seen:
            continue
        name = str(raw.get("name") or profile_id)
        username = str(raw.get("username") or profile_id)
        profiles.append({
            "id": profile_id,
            "name": name,
            "username": username,
            "profilesFolder": str(auth_profile_folder(profile_id)),
        })
        seen.add(profile_id)

    selected = data.get("selected")
    selected_id = safe_profile_id(str(selected)) if selected else None
    if selected_id not in seen:
        selected_id = profiles[0]["id"] if profiles else None
    return profiles, selected_id


def save_auth_profile_store(profiles: list[dict], selected_id: str | None) -> None:
    AUTH_PROFILES_DIR.mkdir(parents=True, exist_ok=True)
    clean_profiles = []
    for profile in profiles:
        profile_id = safe_profile_id(str(profile.get("id") or profile.get("name") or "account"))
        clean_profiles.append({
            "id": profile_id,
            "name": str(profile.get("name") or profile_id),
            "username": str(profile.get("username") or profile_id),
        })
    AUTH_PROFILE_INDEX.write_text(
        json.dumps({"selected": selected_id, "profiles": clean_profiles}, indent=2),
        encoding="utf-8",
    )


def profile_has_auth_cache(profile: dict | None) -> bool:
    if not profile:
        return False
    folder = Path(str(profile.get("profilesFolder") or ""))
    try:
        return folder.exists() and any(folder.glob("*-cache.json"))
    except OSError:
        return False


def process_alive(pid: int | None) -> bool:
    if not pid:
        return False
    try:
        subprocess.run(
            ["powershell.exe", "-NoLogo", "-NoProfile", "-Command", f"Get-Process -Id {int(pid)} -ErrorAction Stop | Out-Null"],
            cwd=PROJECT_ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=3,
            check=True,
        )
        return True
    except Exception:
        return False


def parse_realms(output: str) -> list[dict]:
    realms: list[dict] = []
    for line in output.splitlines():
        match = REALM_LINE_RE.match(line)
        if not match:
            continue
        realm = match.groupdict()
        realm["index"] = int(realm["index"])
        realm["label"] = f"{realm['name']} | {realm['state']} | {realm['id']}"
        realms.append(realm)
    return realms


class BridgeDesktopGui:
    def __init__(self) -> None:
        self.root = tk.Tk()
        self.root.title("JavaRock")
        self.root.geometry("980x680")
        self.root.minsize(760, 520)

        self.style = ttk.Style(self.root)
        if "clam" in self.style.theme_names():
            self.style.theme_use("clam")
        preferences = read_json(GUI_PREFERENCES_FILE)

        self.log_queue: queue.Queue[tuple[str, str]] = queue.Queue()
        self.bridge_process: subprocess.Popen | None = None
        self.realms: list[dict] = []
        self.auth_profiles: list[dict] = []
        self.selected_profile_id: str | None = None
        self.account_label_to_id: dict[str, str] = {}

        self.top_status_var = tk.StringVar(value="stopped | no account")
        self.state_var = tk.StringVar(value="stopped")
        self.account_var = tk.StringVar(value="")
        self.account_status_var = tk.StringVar(value="Login required")
        self.join_var = tk.StringVar(value="localhost:25565")
        self.realm_var = tk.StringVar(value="")
        self.manual_realm_var = tk.StringVar(value="")
        self.mode_var = tk.StringVar(value="ViaBedrock relay")
        self.target_version_var = tk.StringVar(value="Bedrock 1.26.30")
        self.upstream_version_var = tk.StringVar(value="1.26.30")
        self.run_checks_var = tk.BooleanVar(value=False)
        self.run_checks_available = (PROJECT_ROOT / "run-checked-bridge-latest.ps1").exists()
        self.dark_mode_var = tk.BooleanVar(value=bool(preferences.get("darkMode", False)))
        self.bridge_pid_var = tk.StringVar(value="-")
        self.via_pid_var = tk.StringVar(value="-")
        self.upstream_var = tk.StringVar(value="-")

        self.build_ui()
        self.apply_theme()
        self.on_mode_selected()
        self.load_account_profiles()
        self.root.protocol("WM_DELETE_WINDOW", self.on_close)
        self.root.after(250, self.drain_log_queue)
        self.root.after(1000, self.poll_status)
        if self.current_profile():
            self.refresh_realms()
        else:
            self.append_log("gui", "No Microsoft account profiles are on record. Login before listing Realms or starting the bridge.")
            self.root.after(350, self.ensure_account_on_startup)

    def build_ui(self) -> None:
        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(3, weight=1)

        self.menubar = tk.Menu(self.root)
        self.account_menu = tk.Menu(self.menubar, tearoff=0)
        self.account_menu.add_command(label="Login / Add Account", command=self.login_account)
        self.account_menu.add_command(label="Logout / Forget Account", command=self.logout_account)
        self.account_menu.add_separator()
        self.account_menu.add_command(label="Refresh Realms", command=self.refresh_realms)
        self.menubar.add_cascade(label="Microsoft Account", menu=self.account_menu)
        self.view_menu = tk.Menu(self.menubar, tearoff=0)
        self.view_menu.add_checkbutton(
            label="Dark mode",
            variable=self.dark_mode_var,
            command=self.on_theme_toggled,
        )
        self.menubar.add_cascade(label="View", menu=self.view_menu)
        self.root.config(menu=self.menubar)

        top = ttk.Frame(self.root, padding=(12, 10))
        top.grid(row=0, column=0, sticky="ew")
        top.columnconfigure(0, weight=1)
        ttk.Label(top, text="JavaRock", font=("Segoe UI", 16, "bold")).grid(row=0, column=0, sticky="w")
        ttk.Checkbutton(
            top,
            text="Dark mode",
            variable=self.dark_mode_var,
            command=self.on_theme_toggled,
        ).grid(row=0, column=1, sticky="e")
        self.top_status_label = ttk.Label(
            top,
            textvariable=self.top_status_var,
            anchor="e",
            justify="right",
        )
        self.top_status_label.grid(row=1, column=0, columnspan=2, sticky="ew", pady=(5, 0))
        top.bind("<Configure>", self.on_top_resized)

        account = ttk.LabelFrame(self.root, text="Microsoft Account", padding=12)
        account.grid(row=1, column=0, sticky="ew", padx=12, pady=(0, 10))
        account.columnconfigure(1, weight=1)

        ttk.Label(account, text="Account").grid(row=0, column=0, sticky="w")
        self.account_combo = ttk.Combobox(account, textvariable=self.account_var, state="disabled", values=[])
        self.account_combo.grid(row=0, column=1, sticky="ew", padx=(8, 8))
        self.account_combo.bind("<<ComboboxSelected>>", self.on_account_selected)
        ttk.Button(account, text="Login / Add", command=self.login_account).grid(row=0, column=2, sticky="ew", padx=(0, 8))
        self.logout_button = ttk.Button(account, text="Logout / Forget", command=self.logout_account)
        self.logout_button.grid(row=0, column=3, sticky="ew")
        ttk.Label(account, textvariable=self.account_status_var).grid(row=1, column=1, columnspan=3, sticky="w", pady=(8, 0))

        controls = ttk.LabelFrame(self.root, text="Launch", padding=12)
        controls.grid(row=2, column=0, sticky="ew", padx=12, pady=(0, 10))
        for col in range(6):
            controls.columnconfigure(col, weight=1)

        ttk.Label(controls, text="Realm").grid(row=0, column=0, sticky="w")
        self.realm_combo = ttk.Combobox(controls, textvariable=self.realm_var, state="readonly", values=[])
        self.realm_combo.grid(row=1, column=0, columnspan=3, sticky="ew", padx=(0, 8))
        self.realm_combo.bind("<<ComboboxSelected>>", self.on_realm_selected)
        self.refresh_button = ttk.Button(controls, text="Refresh", command=self.refresh_realms)
        self.refresh_button.grid(row=1, column=3, sticky="ew", padx=(0, 8))

        ttk.Label(controls, text="Manual Realm").grid(row=0, column=4, sticky="w")
        ttk.Entry(controls, textvariable=self.manual_realm_var).grid(row=1, column=4, columnspan=2, sticky="ew")

        ttk.Label(controls, text="Mode").grid(row=2, column=0, sticky="w", pady=(10, 0))
        self.mode_combo = ttk.Combobox(
            controls,
            textvariable=self.mode_var,
            state="readonly",
            values=["ViaBedrock relay", "Bedrock packet recorder"],
        )
        self.mode_combo.grid(row=3, column=0, columnspan=2, sticky="ew", padx=(0, 8))
        self.mode_combo.bind("<<ComboboxSelected>>", self.on_mode_selected)

        self.target_version_label = ttk.Label(controls, text="ViaBedrock target")
        self.target_version_label.grid(row=2, column=2, sticky="w", pady=(10, 0))
        self.target_version_entry = ttk.Entry(controls, textvariable=self.target_version_var)
        self.target_version_entry.grid(row=3, column=2, sticky="ew", padx=(0, 8))

        ttk.Label(controls, text="Realm client").grid(row=2, column=3, sticky="w", pady=(10, 0))
        ttk.Entry(controls, textvariable=self.upstream_version_var).grid(row=3, column=3, sticky="ew", padx=(0, 8))

        self.run_checks_button = ttk.Checkbutton(controls, text="Run smoke suite first", variable=self.run_checks_var)
        if self.run_checks_available:
            self.run_checks_button.grid(row=3, column=4, sticky="w")

        self.start_button = ttk.Button(controls, text="Start", command=self.start_bridge)
        self.start_button.grid(row=4, column=0, sticky="ew", pady=(12, 0), padx=(0, 8))
        ttk.Button(controls, text="Stop", command=self.stop_bridge).grid(row=4, column=1, sticky="ew", pady=(12, 0), padx=(0, 8))
        ttk.Button(controls, text="Open Logs Folder", command=self.open_logs_folder).grid(row=4, column=2, sticky="ew", pady=(12, 0), padx=(0, 8))

        status = ttk.Frame(controls)
        status.grid(row=4, column=3, columnspan=3, sticky="ew", pady=(12, 0))
        status.columnconfigure(1, weight=1)
        ttk.Label(status, text="Join").grid(row=0, column=0, sticky="w")
        ttk.Label(status, textvariable=self.join_var).grid(row=0, column=1, sticky="w", padx=(8, 18))
        ttk.Label(status, text="Bridge").grid(row=0, column=2, sticky="w")
        ttk.Label(status, textvariable=self.bridge_pid_var).grid(row=0, column=3, sticky="w", padx=(8, 18))
        ttk.Label(status, text="ViaProxy").grid(row=0, column=4, sticky="w")
        ttk.Label(status, textvariable=self.via_pid_var).grid(row=0, column=5, sticky="w", padx=(8, 0))

        log_frame = ttk.LabelFrame(self.root, text="Log", padding=8)
        log_frame.grid(row=3, column=0, sticky="nsew", padx=12, pady=(0, 12))
        log_frame.columnconfigure(0, weight=1)
        log_frame.rowconfigure(0, weight=1)

        self.log_text = tk.Text(log_frame, wrap="word", height=24, font=("Consolas", 10))
        self.log_text.grid(row=0, column=0, sticky="nsew")
        scroll = ttk.Scrollbar(log_frame, orient="vertical", command=self.log_text.yview)
        scroll.grid(row=0, column=1, sticky="ns")
        self.log_text.configure(yscrollcommand=scroll.set)

    def on_top_resized(self, event) -> None:
        self.top_status_label.configure(wraplength=max(320, int(event.width) - 24))

    def on_theme_toggled(self) -> None:
        save_gui_preferences(self.dark_mode_var.get())
        self.apply_theme()

    def apply_theme(self) -> None:
        dark = self.dark_mode_var.get()
        colors = {
            "background": "#15181d" if dark else "#f4f6f8",
            "surface": "#20242b" if dark else "#ffffff",
            "field": "#292f38" if dark else "#ffffff",
            "foreground": "#f2f4f7" if dark else "#171a1f",
            "muted": "#aeb6c2" if dark else "#5f6875",
            "border": "#3a424e" if dark else "#cbd1d8",
            "active": "#343c48" if dark else "#e8edf3",
            "selected": "#3d74c5" if dark else "#2f6fca",
        }

        background = colors["background"]
        surface = colors["surface"]
        field = colors["field"]
        foreground = colors["foreground"]
        border = colors["border"]
        active = colors["active"]
        selected = colors["selected"]

        self.root.configure(background=background)
        self.style.configure(".", background=background, foreground=foreground)
        self.style.configure("TFrame", background=background)
        self.style.configure("TLabel", background=background, foreground=foreground)
        self.style.configure("TLabelframe", background=background, bordercolor=border)
        self.style.configure("TLabelframe.Label", background=background, foreground=foreground)
        self.style.configure("TButton", background=surface, foreground=foreground, bordercolor=border, padding=(8, 5))
        self.style.map("TButton", background=[("active", active), ("pressed", selected)])
        self.style.configure("TCheckbutton", background=background, foreground=foreground)
        self.style.map("TCheckbutton", background=[("active", background)], foreground=[("disabled", colors["muted"])])
        self.style.configure("TEntry", fieldbackground=field, foreground=foreground, bordercolor=border, insertcolor=foreground)
        self.style.configure("TCombobox", fieldbackground=field, foreground=foreground, background=surface, bordercolor=border, arrowcolor=foreground)
        self.style.map(
            "TCombobox",
            fieldbackground=[("readonly", field), ("disabled", surface)],
            foreground=[("readonly", foreground), ("disabled", colors["muted"])],
            selectbackground=[("readonly", selected)],
            selectforeground=[("readonly", "#ffffff")],
        )
        self.style.configure("TScrollbar", background=surface, troughcolor=background, bordercolor=border, arrowcolor=foreground)

        self.root.option_add("*TCombobox*Listbox.background", field)
        self.root.option_add("*TCombobox*Listbox.foreground", foreground)
        self.root.option_add("*TCombobox*Listbox.selectBackground", selected)
        self.root.option_add("*TCombobox*Listbox.selectForeground", "#ffffff")

        if hasattr(self, "log_text"):
            self.log_text.configure(
                background=surface,
                foreground=foreground,
                insertbackground=foreground,
                selectbackground=selected,
                selectforeground="#ffffff",
                highlightbackground=border,
                highlightcolor=selected,
            )

        for menu in (getattr(self, "menubar", None), getattr(self, "account_menu", None), getattr(self, "view_menu", None)):
            if menu is not None:
                menu.configure(
                    background=surface,
                    foreground=foreground,
                    activebackground=selected,
                    activeforeground="#ffffff",
                )

    def append_log(self, source: str, text: str) -> None:
        timestamp = time.strftime("%H:%M:%S")
        self.log_text.insert("end", f"[{timestamp}] [{source}] {text.rstrip()}\n")
        self.log_text.see("end")

    def queue_log(self, source: str, text: str) -> None:
        self.log_queue.put((source, text))

    def drain_log_queue(self) -> None:
        while True:
            try:
                source, text = self.log_queue.get_nowait()
            except queue.Empty:
                break
            self.append_log(source, text)
        self.root.after(250, self.drain_log_queue)

    def profile_label(self, profile: dict) -> str:
        name = str(profile.get("name") or profile.get("id") or "account")
        username = str(profile.get("username") or profile.get("id") or "account")
        return f"{name} ({username})" if username != name else name

    def current_profile(self) -> dict | None:
        if not self.selected_profile_id:
            return None
        return next((profile for profile in self.auth_profiles if profile.get("id") == self.selected_profile_id), None)

    def load_account_profiles(self) -> None:
        self.auth_profiles, self.selected_profile_id = load_auth_profile_store()
        self.sync_account_controls()

    def sync_account_controls(self) -> None:
        self.account_label_to_id = {}
        labels: list[str] = []
        selected_label = ""
        for profile in self.auth_profiles:
            label = self.profile_label(profile)
            labels.append(label)
            self.account_label_to_id[label] = str(profile["id"])
            if profile.get("id") == self.selected_profile_id:
                selected_label = label

        self.account_combo.configure(values=labels, state="readonly" if labels else "disabled")
        self.account_var.set(selected_label)
        has_profile = self.current_profile() is not None
        self.start_button.configure(state="normal" if has_profile else "disabled")
        self.refresh_button.configure(state="normal" if has_profile else "disabled")
        self.logout_button.configure(state="normal" if has_profile else "disabled")
        self.update_account_status()
        self.update_top_status()

    def update_account_status(self) -> None:
        profile = self.current_profile()
        if not profile:
            self.account_status_var.set("No Microsoft account profile selected.")
            return
        cache_state = "auth cache ready" if profile_has_auth_cache(profile) else "login needed"
        self.account_status_var.set(f"{self.profile_label(profile)} | {cache_state}")

    def update_top_status(self, state: str | None = None) -> None:
        profile = self.current_profile()
        account = profile.get("name") if profile else "no account"
        pieces = [state or self.state_var.get(), self.mode_var.get(), f"account: {account}", f"join: {self.join_var.get()}"]
        upstream = self.upstream_var.get()
        if upstream and upstream != "-":
            pieces.append(upstream)
        self.top_status_var.set(" | ".join(pieces))

    def ensure_account_on_startup(self) -> None:
        if not self.auth_profiles:
            self.login_account()

    def unique_profile_id(self, base: str) -> str:
        root = safe_profile_id(base)
        used = {str(profile.get("id")) for profile in self.auth_profiles}
        if root not in used:
            return root
        suffix = 2
        while f"{root}-{suffix}" in used:
            suffix += 1
        return f"{root}-{suffix}"

    def login_account(self) -> None:
        name = simpledialog.askstring(
            "Microsoft Login",
            "Account profile name",
            parent=self.root,
            initialvalue="Microsoft Account",
        )
        if not name or not name.strip():
            self.append_log("gui", "Login canceled; no account profile selected.")
            return

        profile_id = self.unique_profile_id(name)
        profile = {
            "id": profile_id,
            "name": name.strip(),
            "username": profile_id,
            "profilesFolder": str(auth_profile_folder(profile_id)),
        }
        Path(profile["profilesFolder"]).mkdir(parents=True, exist_ok=True)
        self.auth_profiles.append(profile)
        self.selected_profile_id = profile_id
        save_auth_profile_store(self.auth_profiles, self.selected_profile_id)
        self.sync_account_controls()
        self.append_log("gui", f"Added account profile '{profile['name']}'. Realm refresh will start Microsoft device-code login if needed.")
        self.refresh_realms()

    def logout_account(self) -> None:
        profile = self.current_profile()
        if not profile:
            return
        if self.bridge_process and self.bridge_process.poll() is None:
            if not messagebox.askyesno("Bridge is running", "Forget this account while the bridge is still running?"):
                return
        label = self.profile_label(profile)
        if not messagebox.askyesno("Logout / Forget Account", f"Forget {label} and delete its cached Microsoft tokens?"):
            return

        folder = Path(str(profile.get("profilesFolder") or "")).resolve()
        root = AUTH_PROFILES_DIR.resolve()
        try:
            if folder != root and root in folder.parents and folder.exists():
                shutil.rmtree(folder)
        except OSError as exc:
            self.append_log("gui", f"Could not delete auth cache for {label}: {exc}")

        self.auth_profiles = [item for item in self.auth_profiles if item.get("id") != profile.get("id")]
        self.selected_profile_id = self.auth_profiles[0]["id"] if self.auth_profiles else None
        save_auth_profile_store(self.auth_profiles, self.selected_profile_id)
        self.set_realms([])
        self.sync_account_controls()
        self.append_log("gui", f"Forgot account profile {label}.")

    def on_account_selected(self, _event=None) -> None:
        label = self.account_var.get()
        selected = self.account_label_to_id.get(label)
        if not selected or selected == self.selected_profile_id:
            return
        self.selected_profile_id = selected
        save_auth_profile_store(self.auth_profiles, self.selected_profile_id)
        self.set_realms([])
        self.sync_account_controls()
        self.append_log("gui", f"Switched account profile to {label}.")
        self.refresh_realms()

    def selected_realm_args(self, powershell: bool) -> list[str]:
        label = self.realm_var.get()
        realm = next((item for item in self.realms if item.get("label") == label), None)
        manual = self.manual_realm_var.get().strip()
        if realm and realm.get("id"):
            return (["-RealmId", realm["id"]] if powershell else ["--realm-id", realm["id"]])
        if realm and isinstance(realm.get("index"), int):
            return (["-RealmIndex", str(realm["index"])] if powershell else ["--realm-index", str(realm["index"])])
        if manual:
            return (["-RealmName", manual] if powershell else ["--realm-name", manual])
        return (["-RealmIndex", "0"] if powershell else ["--realm-index", "0"])

    def on_realm_selected(self, _event=None) -> None:
        label = self.realm_var.get()
        realm = next((item for item in self.realms if item.get("label") == label), None)
        if realm and realm.get("name"):
            self.manual_realm_var.set(realm["name"])

    def on_mode_selected(self, _event=None) -> None:
        recorder = self.mode_var.get() == "Bedrock packet recorder"
        self.target_version_entry.configure(state="disabled" if recorder else "normal")
        if not self.run_checks_available:
            self.run_checks_var.set(False)
        self.run_checks_button.configure(state="disabled" if recorder or not self.run_checks_available else "normal")
        self.start_button.configure(text="Start Recorder" if recorder else "Start Bridge")
        if self.state_var.get() == "stopped":
            self.join_var.set("127.0.0.1:19133" if recorder else "localhost:25565")
        self.update_top_status()

    def refresh_realms(self) -> None:
        profile = self.current_profile()
        if not profile:
            self.append_log("gui", "Login before refreshing Realms.")
            self.sync_account_controls()
            return
        self.append_log("gui", f"Refreshing Realm list for {self.profile_label(profile)}...")
        threading.Thread(target=self._refresh_realms_worker, args=(dict(profile),), daemon=True).start()

    def _refresh_realms_worker(self, profile: dict) -> None:
        cmd = [
            "node",
            "src/index.js",
            "list-realms",
            "--profiles-folder",
            str(profile["profilesFolder"]),
            "--username",
            str(profile["username"]),
        ]
        env = os.environ.copy()
        env["PROFILES_FOLDER"] = str(profile["profilesFolder"])
        env["BRIDGE_USERNAME"] = str(profile["username"])
        try:
            result = subprocess.run(
                cmd,
                cwd=PROJECT_ROOT,
                env=env,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                timeout=120,
            )
            self.queue_log("realms", result.stdout or "")
            realms = parse_realms(result.stdout or "")
            self.root.after(0, lambda: self.set_realms(realms))
        except Exception as exc:
            self.queue_log("realms", f"Realm refresh failed: {exc}")

    def set_realms(self, realms: list[dict]) -> None:
        self.realms = realms
        labels = [realm["label"] for realm in realms]
        self.realm_combo.configure(values=labels)
        if labels and self.realm_var.get() not in labels:
            self.realm_var.set(labels[0])
        elif not labels:
            self.realm_var.set("")
        self.on_realm_selected()
        self.update_account_status()

    def start_bridge(self) -> None:
        if self.bridge_process and self.bridge_process.poll() is None:
            self.append_log("gui", "Bridge process is already running from this window.")
            return

        profile = self.current_profile()
        if not profile:
            messagebox.showinfo("Microsoft login required", "Login to a Microsoft account profile before starting the bridge.")
            self.append_log("gui", "Start canceled because no Microsoft account profile is selected.")
            return

        mode = self.mode_var.get()
        if mode == "Bedrock packet recorder":
            cmd = [
                powershell_exe(),
                "-NoLogo",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(PROJECT_ROOT / "run-bedrock-packet-recorder-latest.ps1"),
                *self.selected_realm_args(powershell=True),
                "-BedrockVersion",
                self.upstream_version_var.get().strip() or "1.26.30",
                "-StatusFile",
                str(STATUS_FILE),
            ]
        else:
            script = "run-checked-bridge-latest.ps1" if self.run_checks_var.get() else "run-bridge-via-bedrock-relay-latest.ps1"
            cmd = [
                powershell_exe(),
                "-NoLogo",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(PROJECT_ROOT / script),
                *self.selected_realm_args(powershell=True),
                "-ViaProxyBedrockTargetVersion",
                self.target_version_var.get().strip() or "Bedrock 1.26.30",
                "-UpstreamBedrockVersion",
                self.upstream_version_var.get().strip() or "1.26.30",
            ]

        env = os.environ.copy()
        env["BRIDGE_STATUS_FILE"] = str(STATUS_FILE)
        env["PROFILES_FOLDER"] = str(profile["profilesFolder"])
        env["BRIDGE_USERNAME"] = str(profile["username"])
        STDOUT_LOG.write_text(f"[desktop-gui] Launch requested at {time.strftime('%Y-%m-%dT%H:%M:%S')}\n", encoding="utf-8")
        STDERR_LOG.write_text("", encoding="utf-8")
        launch_label = "Bedrock packet recorder" if mode == "Bedrock packet recorder" else "ViaBedrock relay"
        self.append_log("gui", f"Starting {launch_label} with account profile {self.profile_label(profile)}...")
        self.append_log("gui", " ".join(cmd))

        try:
            self.bridge_process = subprocess.Popen(
                cmd,
                cwd=PROJECT_ROOT,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
            )
        except Exception as exc:
            messagebox.showerror("Bridge launch failed", str(exc))
            self.append_log("gui", f"Launch failed: {exc}")
            return

        threading.Thread(target=self._pipe_reader, args=(self.bridge_process.stdout, STDOUT_LOG, "stdout"), daemon=True).start()
        threading.Thread(target=self._pipe_reader, args=(self.bridge_process.stderr, STDERR_LOG, "stderr"), daemon=True).start()
        threading.Thread(target=self._wait_bridge, daemon=True).start()

    def _pipe_reader(self, stream, path: Path, source: str) -> None:
        if stream is None:
            return
        with path.open("a", encoding="utf-8", errors="replace") as log_file:
            for line in stream:
                log_file.write(line)
                log_file.flush()
                self.queue_log(source, line)

    def _wait_bridge(self) -> None:
        process = self.bridge_process
        if process is None:
            return
        code = process.wait()
        self.queue_log("gui", f"Launch process exited with code {code}.")

    def stop_bridge(self) -> None:
        self.append_log("gui", "Stopping active process...")
        cmd = [
            powershell_exe(),
            "-NoLogo",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(PROJECT_ROOT / "stop-bridge.ps1"),
            "-StatusFile",
            str(STATUS_FILE),
        ]
        try:
            result = subprocess.run(cmd, cwd=PROJECT_ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=30)
            self.append_log("stop", result.stdout or "Stop command finished.")
        except Exception as exc:
            self.append_log("stop", f"Stop failed: {exc}")
        if self.bridge_process and self.bridge_process.poll() is None:
            self.bridge_process.terminate()

    def open_logs_folder(self) -> None:
        try:
            os.startfile(str(RUNTIME_DIR))
        except Exception as exc:
            self.append_log("gui", f"Could not open logs folder: {exc}")

    def poll_status(self) -> None:
        status = read_json(STATUS_FILE)
        state = status.get("state") or "stopped"
        self.state_var.set(state)
        manual = status.get("manualJoin") or {}
        default_join = "127.0.0.1:19133" if self.mode_var.get() == "Bedrock packet recorder" else "localhost:25565"
        self.join_var.set(manual.get("serverAddress") or default_join)
        pid = status.get("pid")
        via_pid = (status.get("viaProxy") or {}).get("pid")
        self.bridge_pid_var.set(f"{pid} {'running' if process_alive(pid) else 'stopped'}" if pid else "-")
        self.via_pid_var.set(f"{via_pid} {'running' if process_alive(via_pid) else 'stopped'}" if via_pid else "-")
        relay = status.get("bedrockRelay") or {}
        bedrock = status.get("bedrock") or {}
        upstream_bits = []
        if relay.get("error"):
            upstream_bits.append(str(relay["error"]).splitlines()[0])
        if "chunkCount" in bedrock:
            upstream_bits.append(f"chunks={bedrock['chunkCount']}")
        self.upstream_var.set(" ".join(upstream_bits) if upstream_bits else "-")
        self.update_account_status()
        self.update_top_status(state)
        self.root.after(1500, self.poll_status)

    def on_close(self) -> None:
        if self.bridge_process and self.bridge_process.poll() is None:
            if not messagebox.askyesno("Bridge still running", "Close the launcher while the bridge is still running?"):
                return
        self.root.destroy()

    def run(self) -> None:
        self.root.mainloop()


def main() -> int:
    BridgeDesktopGui().run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
