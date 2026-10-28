package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"syscall"

	"lingtu.local/workbench/tailnet/internal/securestate"
	"lingtu.local/workbench/tailnet/internal/sidecar"
	"lingtu.local/workbench/tailnet/internal/tsbackend"
	"tailscale.com/logtail"
)

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		fmt.Println("lingtu-tailnet 0.1.0 protocol/1 tailscale/1.104.2 prototype")
		return
	}
	if len(os.Args) != 1 {
		fmt.Fprintln(os.Stderr, "only --version or private stdio control is supported")
		os.Exit(2)
	}
	// Child process only: prevent upstream log uploads and plaintext log buffers.
	if err := os.Setenv("TS_NO_LOGS_NO_SUPPORT", "true"); err != nil {
		os.Exit(1)
	}
	logtail.Disable()
	log.SetOutput(io.Discard)
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	go func() { <-ctx.Done(); _ = os.Stdin.Close() }()
	err := sidecar.Run(ctx, os.Stdin, os.Stdout, func(config sidecar.Config) (*sidecar.Manager, error) {
		lock, err := securestate.Acquire(config.StateDir)
		if errors.Is(err, securestate.ErrStateInUse) {
			return nil, &sidecar.Error{Code: "STATE_IN_USE", Message: "another connection backend owns this private state directory"}
		}
		if err != nil {
			return nil, &sidecar.Error{Code: "STATE_UNAVAILABLE", Message: "private state directory could not be secured"}
		}
		manager, err := sidecar.New(config, tsbackend.New, lock)
		if err != nil {
			_ = lock.Close()
		}
		return manager, err
	})
	if err != nil && ctx.Err() == nil {
		fmt.Fprintln(os.Stderr, "private control stream closed with an error")
		os.Exit(1)
	}
}
