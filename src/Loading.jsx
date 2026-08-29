// One loading indicator, used everywhere a panel is waiting on the device.
//
// Every tab talks to the shell when it mounts, behind a 200ms floor between
// commands, so "waiting" is a normal state rather than an edge case — and a
// panel that renders its headings over empty lists while it waits looks like a
// panel that failed.

export default function Loading({ label = "Reading from the device…" }) {
  return (
    <p className="loading" role="status">
      <span className="loading__spinner" aria-hidden="true" />
      {label}
    </p>
  );
}
