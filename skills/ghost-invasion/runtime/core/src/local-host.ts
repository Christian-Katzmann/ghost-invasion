// Shared loopback classifier for the safety-sensitive local-host guards.
//
// The API tier and the auth adapters all need to answer one question identically: "is this
// hostname a loopback address on this box?" A prefix test like `hostname.startsWith("127.")`
// is unsafe — it accepts `127.0.0.1.evil.example`, a remote domain that merely *starts* with
// the loopback prefix, which would let host-side traffic or a minted session escape off-box.
// This does a real numeric 127.0.0.0/8 range check on a dotted-quad IPv4 hostname.
export function isLoopbackIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return false;
  }
  return Number(parts[0]) === 127;
}
