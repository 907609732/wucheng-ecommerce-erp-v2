package securestate

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"

	"tailscale.com/atomicfile"
	"tailscale.com/ipn"
)

var ErrStateInUse = errors.New("STATE_IN_USE")
var magic = []byte("LingtuTsnetDPAPI1\x00")

type Store struct {
	mu   sync.RWMutex
	file string
	data map[ipn.StateKey][]byte
}

func New(dir string) (*Store, error) {
	if err := privateDirectory(dir); err != nil {
		return nil, err
	}
	s := &Store{file: filepath.Join(dir, "node-state.dpapi"), data: map[ipn.StateKey][]byte{}}
	info, err := os.Lstat(s.file)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > 16*1024*1024 {
		return nil, errors.New("invalid encrypted node state file")
	}
	b, err := os.ReadFile(s.file)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	if len(b) > 16*1024*1024 || len(b) <= len(magic) || string(b[:len(magic)]) != string(magic) {
		return nil, errors.New("invalid encrypted node state; plaintext fallback is prohibited")
	}
	plain, err := unprotect(b[len(magic):])
	if err != nil {
		return nil, errors.New("Windows could not decrypt this user's node state")
	}
	defer clear(plain)
	if err := json.Unmarshal(plain, &s.data); err != nil || s.data == nil {
		return nil, errors.New("invalid encrypted node state payload")
	}
	return s, nil
}

func (s *Store) ReadState(key ipn.StateKey) ([]byte, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	b, ok := s.data[key]
	if !ok {
		return nil, ipn.ErrStateNotExist
	}
	return append([]byte(nil), b...), nil
}

func (s *Store) WriteState(key ipn.StateKey, value []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	// Prepare a copy so an encryption or atomic-write failure cannot report an
	// unpersisted in-memory state as successful on a later read.
	next := make(map[ipn.StateKey][]byte, len(s.data)+1)
	for k, v := range s.data {
		next[k] = v
	}
	if value == nil {
		delete(next, key)
	} else {
		next[key] = append([]byte(nil), value...)
	}
	plain, err := json.Marshal(next)
	if err != nil {
		return err
	}
	defer clear(plain)
	if len(plain) > 15*1024*1024 {
		return errors.New("node state exceeds private store limit")
	}
	cipher, err := protect(plain)
	if err != nil {
		return errors.New("Windows could not encrypt node state; nothing was saved")
	}
	if err := atomicfile.WriteFile(s.file, append(append([]byte(nil), magic...), cipher...), 0600); err != nil {
		return err
	}
	s.data = next
	return nil
}

var _ ipn.StateStore = (*Store)(nil)
