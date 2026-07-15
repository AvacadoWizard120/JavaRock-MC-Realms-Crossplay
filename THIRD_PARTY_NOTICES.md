# Third-Party Notices

JavaRock combines original interoperability code with separately licensed software. Each component keeps its own license.

## License Map

| Component | Location | License |
| --- | --- | --- |
| JavaRock-original source | Repository files except the exceptions below | [PolyForm Noncommercial 1.0.0](LICENSE) |
| Modified ViaBedrock compatibility classes | `patches/viabedrock-inventory/` | [GPL-3.0-or-later](LICENSES/GPL-3.0-or-later.txt) |
| ViaProxy and its bundled Via projects | Downloaded by `npm run setup`; not committed here | GPLv3 and applicable upstream licenses |
| Node.js dependencies | Installed from `package-lock.json`; not committed here | Each package's declared license |

The PolyForm noncommercial restriction applies only to material whose copyright holders can grant those terms. It does not add restrictions to GPL-covered or other third-party material.

## Upstream Projects

- ViaProxy: <https://github.com/ViaVersion/ViaProxy>
- ViaBedrock: <https://github.com/RaphiMC/ViaBedrock>
- ViaVersion: <https://github.com/ViaVersion/ViaVersion>
- PrismarineJS: <https://github.com/PrismarineJS>

The setup script downloads ViaProxy from its official GitHub release and builds the local compatibility patch from the corresponding source included in this repository.

Minecraft, Microsoft, Xbox, Mojang, Java, and all related marks belong to their respective owners. JavaRock is an independent interoperability project and is not affiliated with or endorsed by those owners.
