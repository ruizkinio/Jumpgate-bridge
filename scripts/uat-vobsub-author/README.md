# Fixture authoring

This source is retained to make the checked-in UAT VobSub binary reproducible.
It defines an original 5x7 bitmap alphabet and writes three cues using the
MIT-licensed Subtitle Edit LibSE VobSub writer.

1. Check out Subtitle Edit tag `v5.1.0` at commit
   `38f1dd4bac6c70bdf1f2d1bb5952aa414c6cb777` into
   `scripts/uat-vobsub-author/subtitleedit-src`.
2. Build `src/libse/LibSE.csproj` in Release for `netstandard2.1`.
3. Run `dotnet run --project scripts/uat-vobsub-author/author.csproj -c Release -- <output>`.
4. With FFmpeg 8.1 available, run
   `node scripts/uat-vobsub-author/generate-media.js <output>`.

The generator refuses another FFmpeg version and fails unless both the encoded bytes
and ffprobe stream semantics match the reviewed fixture exactly.

The generated IDX and SUB are then archived as the single matching pair served by
the Bridge. The video command and expected hashes are documented with the runtime
assets in `uat-fixtures/vobsub/README.md`. The media generator creates the exact
second-marked test card used to bind rendered cues to media time.
