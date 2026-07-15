package main

import (
	"flag"
	"fmt"
	"os"
)

func main() {
	networkID := flag.String("network-id", "", "remote NetherNet network/session GUID returned by the Realms API")
	flag.Parse()

	if *networkID == "" {
		fmt.Fprintln(os.Stderr, "missing --network-id")
		os.Exit(1)
	}

	fmt.Println("NetherNet lab input accepted.")
	fmt.Println("Remote network id:", *networkID)
	fmt.Println()
	fmt.Println("Next implementation step: wire Microsoft/Xbox-backed Realms signaling, then pass that signaling implementation to github.com/df-mc/go-nethernet.Dialer.")
	os.Exit(2)
}
