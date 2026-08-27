# node-datachannel 0.33.1 (vendored)

License: Mozilla Public License 2.0 (see LICENSE).

Upstream: https://github.com/murat-dogan/node-datachannel

Modifications by tmex:

- Replaced optionalDependency / local-build loader with an absolute-path
  `require` of `<TMEX_NATIVE_DIR>/node_datachannel.node` (or
  `loadBindingFromPath`).
- Dropped `detect-libc` from this JS layer; libc detection lives in
  `packages/app/src/lib/native-manifest.ts` and is used by `tmex direct enable`.
