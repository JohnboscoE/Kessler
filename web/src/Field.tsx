/**
 * The background slot, DESIGN.md §8.
 *
 * Permitted in the hero only — never behind the shell diagram or any data
 * surface. The asset is pre-baked (greyscaled, cold-tinted, levelled, audio
 * stripped, crossfade-looped); no runtime CSS filter is applied, because
 * per-frame video filters are GPU-expensive and jank on lower-end machines.
 */
export function Field() {
  return (
    <div className="field">
      <video
        className="field__video"
        src="/kessler-field.mp4"
        poster="/kessler-field.jpg"
        autoPlay
        muted
        loop
        playsInline
        preload="metadata"
        aria-hidden="true"
      />
      <div className="field__scrim" />
    </div>
  );
}
