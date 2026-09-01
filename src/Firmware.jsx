import { useCallback, useEffect, useState } from "react";
import { compareVersions, isUF2, parseFirmware, pickAsset } from "./protocol.js";
import Loading from "./Loading.jsx";

// Firmware: what the board is running, what the config repo has published, and
// a guided write to the bootloader drive.
//
// The download itself is a link rather than a fetch, and that is not laziness.
// GitHub release assets redirect to release-assets.githubusercontent.com, which
// sends no Access-Control-Allow-Origin, so a browser cannot read the bytes —
// the API's own 302 does carry CORS, but every response in a redirect chain has
// to pass and the final one does not. A proxy would mean a server, would break
// the single-file offline build, and would route firmware through a third
// party. So the user downloads; the app does everything around it.

const REPO_KEY = "anastasia-firmware-repo";
// Upstream, not a fork. This is where the firmware people actually run comes
// from, and it is the right answer for anyone opening the app for the first
// time; the field is editable for anyone building their own.
const DEFAULT_REPO = "efogtech/endgame-trackball-config";

const canPickDirectory = () => typeof window !== "undefined" && "showDirectoryPicker" in window;

export default function Firmware({ live, firmware, onNote }) {
  const [repo, setRepo] = useState(() => {
    try { return localStorage.getItem(REPO_KEY) || DEFAULT_REPO; } catch { return DEFAULT_REPO; }
  });
  const [release, setRelease] = useState(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(null);

  const [drive, setDrive] = useState(null);
  const [file, setFile] = useState(null);
  const [writing, setWriting] = useState(false);

  const board = parseFirmware(firmware);

  const check = useCallback(async (which) => {
    if (!which || !which.includes("/")) return;
    setChecking(true); setError(null); setRelease(null);
    try {
      const r = await fetch(`https://api.github.com/repos/${which}/releases/latest`, {
        headers: { Accept: "application/vnd.github+json" },
      });
      if (r.status === 404) throw new Error(`No published releases for ${which}.`);
      if (r.status === 403) throw new Error("GitHub is rate-limiting this address. Try again in a few minutes.");
      if (!r.ok) throw new Error(`GitHub answered ${r.status}.`);
      const j = await r.json();
      setRelease({
        tag: j.tag_name,
        version: (j.tag_name ?? "").match(/(\d+\.\d+(?:\.\d+)?)/)?.[1] ?? null,
        published: j.published_at ? new Date(j.published_at) : null,
        url: j.html_url,
        assets: j.assets ?? [],
      });
    } catch (err) {
      // A blocked fetch and a dead network look identical from here, so say both.
      setError(String(err?.message ?? err) === "Failed to fetch"
        ? "Could not reach GitHub — no network, or this page is running offline."
        : String(err?.message ?? err));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => { check(repo); }, [check, repo]);

  const asset = release ? pickAsset(release.assets, board?.paw3395) : null;
  const gap = release?.version && board?.version
    ? compareVersions(release.version, board.version) : null;

  const chooseDrive = async () => {
    try {
      const handle = await window.showDirectoryPicker({ id: "uf2-bootloader", mode: "readwrite" });
      // A UF2 bootloader always publishes INFO_UF2.TXT. Without this check the
      // picker will happily accept Documents, and firmware would land there.
      let ok = false;
      for await (const name of handle.keys()) {
        if (name.toUpperCase() === "INFO_UF2.TXT") { ok = true; break; }
      }
      if (!ok) {
        setDrive(null);
        onNote?.("That folder is not a UF2 bootloader — there is no INFO_UF2.TXT in it. Double-tap reset and pick the drive that appears.");
        return;
      }
      setDrive({ handle, name: handle.name });
      onNote?.(null);
    } catch (err) {
      if (err?.name !== "AbortError") onNote?.(String(err?.message ?? err));
    }
  };

  const chooseFile = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const buf = await f.arrayBuffer();
    const ok = isUF2(buf);
    setFile({ file: f, ok, variant: /paw3395/i.test(f.name) ? "paw3395" : "default" });
    if (!ok) onNote?.(`${f.name} is not a UF2 file. Pick the .uf2 you downloaded, not an archive.`);
  };

  const mismatch = file && board && (file.variant === "paw3395") !== !!board.paw3395;

  const write = async () => {
    if (!drive || !file?.ok) return;
    setWriting(true);
    try {
      const target = await drive.handle.getFileHandle("firmware.uf2", { create: true });
      const w = await target.createWritable();
      await w.write(await file.file.arrayBuffer());
      await w.close();
      onNote?.("Written. The board reboots on its own — connect to it again from the header.");
      setDrive(null); setFile(null);
    } catch (err) {
      // The drive vanishing mid-write is the bootloader rebooting, which is what
      // success looks like from here. Say so rather than reporting a failure.
      const msg = String(err?.message ?? err);
      onNote?.(/NotFound|no longer|removed|not found/i.test(msg)
        ? "The drive disappeared during the write, which is usually the board rebooting into the new firmware. Check whether it came back."
        : `Write failed: ${msg}`);
    } finally {
      setWriting(false);
    }
  };

  return (
    <section className="knobs">
      <h3 className="sec">Firmware</h3>
      <p className="panel__blurb">
        What this board runs, what the firmware repo has released, and a way to
        put one on the other. Point it at your own fork if you build your own.
      </p>

      <dl className="facts">
        <dt>This board</dt>
        <dd>
          {board
            ? `${board.version} · ${board.paw3395 ? "PAW3395 sensor" : "default sensor"}`
            : live ? "reading…" : "connect a board to see its version"}
        </dd>
        <dt>Config repo</dt>
        <dd>
          <input
            className="search"
            value={repo}
            spellCheck={false}
            aria-label="GitHub repository, owner slash name"
            onChange={(e) => setRepo(e.target.value.trim())}
            onBlur={() => { try { localStorage.setItem(REPO_KEY, repo); } catch { /* blocked */ } }}
          />
        </dd>
      </dl>

      {checking && <Loading label="Asking GitHub for the latest release…" />}
      {error && <p className="warn warn--inline">{error}</p>}

      {release && (
        <>
          <dl className="facts">
            <dt>Latest release</dt>
            <dd>{release.tag}{release.published ? ` · ${release.published.toLocaleDateString()}` : ""}</dd>
            <dt>Compared</dt>
            <dd>
              {gap === null ? "these version numbers cannot be compared"
                : gap > 0 ? `newer than this board's ${board.version}`
                  : gap < 0 ? `older than this board's ${board.version}`
                    : "the same version this board is running"}
            </dd>
          </dl>

          <p className="ctl__hint">
            {asset
              ? <>For {board?.paw3395 ? "a PAW3395 board" : "this board"} that is <strong>{asset.name}</strong> ({Math.round(asset.size / 1024)} KB).</>
              : <>This release has no .uf2 matching {board?.paw3395 ? "a PAW3395 board" : "the default sensor"}.</>}
          </p>

          <div className="row row--wrap">
            {asset && (
              <a className="btn btn--primary" href={asset.browser_download_url}>
                Download {asset.name}
              </a>
            )}
            <a className="btn btn--ghost" href={release.url} target="_blank" rel="noreferrer">
              All assets on GitHub
            </a>
            <button className="btn" onClick={() => check(repo)} disabled={checking}>
              Check again
            </button>
          </div>

          <p className="ctl__hint">
            The download is a plain link because a browser cannot read the file
            itself — GitHub serves release assets without a CORS header.
          </p>
        </>
      )}

      <h4 className="advgroup__title">Flash it</h4>

      {!canPickDirectory() ? (
        <p className="ctl__hint">
          This browser cannot write to the drive for you. Double-tap the reset
          button, then drag the downloaded <code>.uf2</code> onto the drive that
          appears. Chrome or Edge on a desktop can do that last step here.
        </p>
      ) : (
        <>
          <ol className="steps">
            <li>
              Double-tap the reset button. The board leaves this app and appears
              as a USB drive.
            </li>
            <li>
              <div className="row row--wrap">
                <button className="btn" onClick={chooseDrive} disabled={writing}>
                  {drive ? `Drive: ${drive.name}` : "Choose the drive"}
                </button>
                {drive && <span className="chip chip--live">UF2 bootloader</span>}
              </div>
            </li>
            <li>
              <div className="row row--wrap">
                <label className="btn">
                  {file ? file.file.name : "Choose the .uf2"}
                  <input type="file" accept=".uf2" hidden onChange={chooseFile} />
                </label>
                {file?.ok && <span className="chip chip--live">verified UF2</span>}
                {file && !file.ok && <span className="chip">not a UF2</span>}
              </div>
              {mismatch && (
                <p className="warn warn--inline">
                  That is the {file.variant === "paw3395" ? "PAW3395" : "default-sensor"} build and
                  this is {board.paw3395 ? "a PAW3395" : "a default-sensor"} board. Writing it will
                  not brick anything — you can re-enter the bootloader and write the other one — but
                  tracking will not work until you do.
                </p>
              )}
            </li>
            <li>
              <button
                className="btn btn--primary"
                onClick={write}
                disabled={!drive || !file?.ok || writing}
              >
                {writing ? "Writing…" : "Write firmware"}
              </button>
            </li>
          </ol>
          <p className="ctl__hint">
            The board reboots itself when the write finishes, so the drive
            disappearing is what success looks like.
          </p>
        </>
      )}
    </section>
  );
}
