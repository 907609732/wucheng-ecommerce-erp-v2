//go:build windows

package securestate

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"tailscale.com/ipn"
)

func TestDPAPIStateRoundTripDeletionAndCorruption(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "private")
	store, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.ReadState("absent"); !errors.Is(err, ipn.ErrStateNotExist) {
		t.Fatal("missing state semantics failed")
	}
	value := []byte("synthetic-current-user-private-state-test-only")
	if err = store.WriteState("synthetic", value); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "node-state.dpapi"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, value) || !bytes.HasPrefix(raw, magic) {
		t.Fatal("state is not encrypted")
	}
	value[0] = 'X'
	copy1, err := store.ReadState("synthetic")
	if err != nil || copy1[0] != 's' {
		t.Fatal("caller write buffer retained")
	}
	copy1[0] = 'Y'
	copy2, _ := store.ReadState("synthetic")
	if copy2[0] != 's' {
		t.Fatal("read exposed mutable state")
	}
	reopened, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	copy3, _ := reopened.ReadState("synthetic")
	if copy3[0] != 's' {
		t.Fatal("DPAPI reopen mismatch")
	}
	if err = store.WriteState("synthetic", nil); err != nil {
		t.Fatal(err)
	}
	reopened, err = New(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = reopened.ReadState("synthetic"); !errors.Is(err, ipn.ErrStateNotExist) {
		t.Fatal("nil delete not persisted")
	}
	if err = os.WriteFile(filepath.Join(dir, "node-state.dpapi"), []byte("plaintext synthetic state must never be read"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = New(dir); err == nil {
		t.Fatal("plaintext fallback accepted")
	}
	if err = os.WriteFile(filepath.Join(dir, "node-state.dpapi"), append(append([]byte(nil), magic...), []byte("corrupt encrypted fixture")...), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = New(dir); err == nil {
		t.Fatal("corrupt ciphertext accepted")
	}
}

func TestStateConcurrentWritesAndExclusiveLock(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "private")
	lock, err := Acquire(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if second, err := Acquire(dir); !errors.Is(err, ErrStateInUse) {
		if second != nil {
			second.Close()
		}
		t.Fatal("second backend acquired the same state")
	}
	if err := os.Remove(filepath.Join(dir, "sidecar.lock")); err == nil {
		t.Fatal("owned lock pathname was deletable")
	}
	store, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for i := range 8 {
		wg.Add(1)
		go func() { defer wg.Done(); errs <- store.WriteState(ipn.StateKey(string(rune('a'+i))), []byte{byte(i)}) }()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	reopened, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	for i := range 8 {
		value, err := reopened.ReadState(ipn.StateKey(string(rune('a' + i))))
		if err != nil || len(value) != 1 || value[0] != byte(i) {
			t.Fatal("concurrent update lost")
		}
	}
	if err = lock.Close(); err != nil {
		t.Fatal(err)
	}
	second, err := Acquire(dir)
	if err != nil {
		t.Fatal("released OS lock could not be acquired")
	}
	second.Close()
	if _, err = os.Stat(filepath.Join(dir, "sidecar.lock")); err != nil {
		t.Fatal("lock file must remain; never reclaim by deletion")
	}
}
