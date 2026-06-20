// Test preload (bunfig.toml [test].preload). Tests must NEVER touch a real OS
// secret vault — macOS keychain / Windows DPAPI / Linux secret-service — so force
// the sqlite backend everywhere by pretending we're in LOCAL_SHELL mode. (The unit
// tests that exercise the real backends inject a fake spawn/crypt instead.)
process.env.LANTERN_LOCAL_SHELL = "1";
