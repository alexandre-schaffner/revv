# Changelog

## [0.4.0](https://github.com/alexandre-schaffner/revv/compare/v0.3.5...v0.4.0) (2026-05-26)


### Features

* **walkthrough:** remove tool-calls collapsible during generation ([1a3e635](https://github.com/alexandre-schaffner/revv/commit/1a3e63517e336da72dc5068ab8489195c2164663))


### Bug Fixes

* **ci:** remove unused exports and non-existent hooks entry to pass knip ([cdb8e98](https://github.com/alexandre-schaffner/revv/commit/cdb8e9893a7bfd2ca1c30584d7f8e510d7352cab))

## [0.3.5](https://github.com/alexandre-schaffner/revv/compare/v0.3.4...v0.3.5) (2026-05-26)


### Bug Fixes

* bash 3.2-safe array expansion in install.sh template ([f16a021](https://github.com/alexandre-schaffner/revv/commit/f16a0214421add45f42859d0590b543846d707d8))

## [0.3.4](https://github.com/alexandre-schaffner/revv/compare/v0.3.3...v0.3.4) (2026-05-26)


### Bug Fixes

* avoid unbound variable on bash 3.2 (macOS) when INSTALLER_ARGS is empty under set -u ([c9e7e16](https://github.com/alexandre-schaffner/revv/commit/c9e7e162879f397dec312e588ca943bab376ac98))

## [0.3.3](https://github.com/alexandre-schaffner/revv/compare/v0.3.2...v0.3.3) (2026-05-26)


### Bug Fixes

* **installer:** harden verified install flow ([99e6f78](https://github.com/alexandre-schaffner/revv/commit/99e6f78a31e97d2ed1405f0c68312a17855c38c9))
* **web:** resolve build warnings ([ab5117a](https://github.com/alexandre-schaffner/revv/commit/ab5117a9b905691b08f7c4c9daff7cc7cd484e83))

## [0.3.2](https://github.com/alexandre-schaffner/revv/compare/v0.3.1...v0.3.2) (2026-05-26)


### Bug Fixes

* **installer:** embed full release installer ([1663b22](https://github.com/alexandre-schaffner/revv/commit/1663b2292d3d78d4fff6b471f420a1e998feacb1))
* **installer:** install server from release script ([f2c8916](https://github.com/alexandre-schaffner/revv/commit/f2c8916c3d64ac1f8942793b6ee58470901462af))

## [0.3.1](https://github.com/alexandre-schaffner/revv/compare/v0.3.0...v0.3.1) (2026-05-26)


### Bug Fixes

* **installer:** use .jsonl extension for attestation bundle temp file ([f658ce7](https://github.com/alexandre-schaffner/revv/commit/f658ce7868e299efce29641befeae08d5e7b0289))

## [0.3.0](https://github.com/alexandre-schaffner/revv/compare/v0.2.5...v0.3.0) (2026-05-26)


### Features

* **cache:** switch team cache auth to Application Default Credentials ([78a744a](https://github.com/alexandre-schaffner/revv/commit/78a744a1e2967e2ee173176c85d08d2eb1d3e727))


### Bug Fixes

* **installer:** replace bash 4+ uppercase expansion for macOS 3.2 compat ([1bd1d22](https://github.com/alexandre-schaffner/revv/commit/1bd1d2258dc1c61085d870cf5d47f3492128d25e))

## [0.2.5](https://github.com/alexandre-schaffner/revv/compare/v0.2.4...v0.2.5) (2026-05-26)


### Features

* **cache:** switch team cache auth to Application Default Credentials (ADC). Removes manual service-account JSON/path inputs. Adds `GET /api/settings/cache/adc-status` and `POST /api/settings/cache/adc-login` endpoints. UI now probes ADC, shows sign-in state, and can launch `gcloud auth application-default login` directly from Settings.

### Bug Fixes

* remove unused RecapToolSpec export ([bc8fa02](https://github.com/alexandre-schaffner/revv/commit/bc8fa020a21f13d1aeb4c8993ab00b7af6c42f46))
* resolve all 23 lint warnings ([e68fdaa](https://github.com/alexandre-schaffner/revv/commit/e68fdaa917750772f931ab8db159c66918dc81cc))
* resolve typecheck errors from lint fixes ([a94a376](https://github.com/alexandre-schaffner/revv/commit/a94a37618bbcdc237b502f9b2de0f8d75f956a70))
* use browser_download_url as sed range end for digest extraction ([0a4ac9c](https://github.com/alexandre-schaffner/revv/commit/0a4ac9cf1e34d36a5c54ae882b13843fa78592ad))

## [0.2.4](https://github.com/alexandre-schaffner/revv/compare/v0.2.3...v0.2.4) (2026-05-26)


### Bug Fixes

* parse GitHub release digest as object instead of string ([31efb1b](https://github.com/alexandre-schaffner/revv/commit/31efb1b848da1589c39371584ad7a97c62fc23a7))

## [0.2.3](https://github.com/alexandre-schaffner/revv/compare/v0.2.2...v0.2.3) (2026-05-26)


### Bug Fixes

* remove biome-ignore comments, use method-bivariant typing instead ([7e4ffd6](https://github.com/alexandre-schaffner/revv/commit/7e4ffd6353f261f1632bf4fd7cb5184669d9362b))
* resolve CI lint annotations (Node 20 actions, noExplicitAny, noNonNullAssertion) ([b139689](https://github.com/alexandre-schaffner/revv/commit/b139689568edb100e7f7ca5dc4e8cfd75402d808))
* resolve CI lint annotations (Node 20 actions, noExplicitAny, noNonNullAssertion) ([b4c9d39](https://github.com/alexandre-schaffner/revv/commit/b4c9d39d128515cf5292c17378798a5e46516a5f))
* stop exporting unused ChatEditToolSpec type ([#86](https://github.com/alexandre-schaffner/revv/issues/86)) ([6da66b9](https://github.com/alexandre-schaffner/revv/commit/6da66b9ceafa4a59ec8050cb253f08948ddd42f8))

## [0.2.2](https://github.com/alexandre-schaffner/revv/compare/v0.2.1...v0.2.2) (2026-05-26)


### Bug Fixes

* **ci:** add GH_REPO env to gh release edit steps ([c64bcc4](https://github.com/alexandre-schaffner/revv/commit/c64bcc4aaa343e21bbc50df3f2179a024a82a9bc))

## [0.2.1](https://github.com/alexandre-schaffner/revv/compare/v0.2.0...v0.2.1) (2026-05-25)


### Bug Fixes

* **release:** create tags for draft releases ([a0f468c](https://github.com/alexandre-schaffner/revv/commit/a0f468cfef08ce8c725499af21871b8f413b28ab))

## [0.2.0](https://github.com/alexandre-schaffner/revv/compare/v0.1.1...v0.2.0) (2026-05-25)


### Features

* add Discard and Cherry-pick actions to proposed-changes strip ([9122d56](https://github.com/alexandre-schaffner/revv/commit/9122d56bbce6d9b9b1cf3b417fc75cb323705a35))
* add shimmer on generate changes button ([b0a408e](https://github.com/alexandre-schaffner/revv/commit/b0a408e8679d8af414d3bdd8465f04874964aece))
* auto-update ([01ff498](https://github.com/alexandre-schaffner/revv/commit/01ff4985f7991370a45a882d16ac11b1cf9fe467))
* awesome ui improvements ([8e35d8d](https://github.com/alexandre-schaffner/revv/commit/8e35d8ddc25194767f1da4af43c4ab6d966e737b))
* better walkthrough ([71529ed](https://github.com/alexandre-schaffner/revv/commit/71529edc432f52c4ce216966a6e45d8080646742))
* big clean 2 ([34c10a1](https://github.com/alexandre-schaffner/revv/commit/34c10a15ab350f19add4ed6b475856bd0cc36381))
* big improvements ([3db8847](https://github.com/alexandre-schaffner/revv/commit/3db8847f8cdb9abbb73f072cc3f132a955528dfa))
* bigcleaning ([318a93a](https://github.com/alexandre-schaffner/revv/commit/318a93a1705e5ff5e28750f191d4de8208cfc4e3))
* **cache:** SSHSIG-anchored team cache integrity ([#74](https://github.com/alexandre-schaffner/revv/issues/74)) ([4b9bfae](https://github.com/alexandre-schaffner/revv/commit/4b9bfaef42005951c5d0fd8ee0f3fc4734846147))
* **chat:** float composer over conversation and fix initial textarea sizing ([#25](https://github.com/alexandre-schaffner/revv/issues/25)) ([07ca0cf](https://github.com/alexandre-schaffner/revv/commit/07ca0cfd8eec59d134e514288bd49b1ae3590ecf))
* **chat:** reattach queue + composer on a shared glass surface ([#28](https://github.com/alexandre-schaffner/revv/issues/28)) ([fbab266](https://github.com/alexandre-schaffner/revv/commit/fbab2665d3fb28f459d80b7a76bc16544c7c9856))
* CI ([35298f3](https://github.com/alexandre-schaffner/revv/commit/35298f3e1b99f38e68bce1394f33dc638ab0de40))
* clean pt2 ([c15c45c](https://github.com/alexandre-schaffner/revv/commit/c15c45cdb04d8eef05e0e285e9c77e5c7acc789c))
* full renaming ([28e8103](https://github.com/alexandre-schaffner/revv/commit/28e8103067406fd53ff354ce647e8e866c9b4738))
* gradient text overlay for repo avatars ([ead0618](https://github.com/alexandre-schaffner/revv/commit/ead0618f3328aafa02fb02a51f6db643931383d0))
* instrumentation ([cb15c63](https://github.com/alexandre-schaffner/revv/commit/cb15c63fdac771ec7b665081e9bdcb701ca9b8b6))
* left pane rework ([198e950](https://github.com/alexandre-schaffner/revv/commit/198e950b4c666f9118839e86997174300163f573))
* left pane rework ([d71368e](https://github.com/alexandre-schaffner/revv/commit/d71368e6eb9229540ecdbd8da0765fca375620e3))
* merge button ([001da9b](https://github.com/alexandre-schaffner/revv/commit/001da9b99472cff5e300596f35f077c96edc5a1a))
* merge button ([a26877e](https://github.com/alexandre-schaffner/revv/commit/a26877e6e943fee2904c4e2359a5eefce35a0678))
* merge button ([bb2f39c](https://github.com/alexandre-schaffner/revv/commit/bb2f39c36e114f99d68e96f77e0b9b4d8867bfb9))
* migrate OpenCode provider to @opencode-ai/sdk ([8308745](https://github.com/alexandre-schaffner/revv/commit/83087451737b1d2ba63c1fbcb4e04d9a6ea96456))
* migrate OpenCode provider to @opencode-ai/sdk ([1467877](https://github.com/alexandre-schaffner/revv/commit/14678771aca57a3186cefbdb4575e45e52480fd6))
* multi-account ([871fd11](https://github.com/alexandre-schaffner/revv/commit/871fd110612ecaf20ef4ee2d551eb22a689e3331))
* onoarding ([8c7339c](https://github.com/alexandre-schaffner/revv/commit/8c7339c426586c068b35a5718b430b099bc0f40a))
* owner-hue fluid SVG gradient avatars ([fc37d18](https://github.com/alexandre-schaffner/revv/commit/fc37d18164c883870df33016ce1673419bf42ad3))
* phosphore ([d5037ab](https://github.com/alexandre-schaffner/revv/commit/d5037abe64d749de9f3aa1764143e5fd2eaf6faf))
* pin PRs ([064bb9b](https://github.com/alexandre-schaffner/revv/commit/064bb9baa72371c55abec7d41ce480c288853675))
* **prs:** one-week retention for archived PRs with poll-time backfill ([7097e0d](https://github.com/alexandre-schaffner/revv/commit/7097e0d3ab553dc0f8f58562775e5b70c5950e1f))
* **prs:** one-week retention for archived PRs with poll-time backfill ([d32f4d4](https://github.com/alexandre-schaffner/revv/commit/d32f4d4c3ddcdac63bd2b9114df19639b7373ee9))
* **prs:** optimistic mutations for owner PR actions ([d0b1091](https://github.com/alexandre-schaffner/revv/commit/d0b1091216cd1ad9a7aff9ba3d2d59cbcc4e53c8))
* **prs:** optimistic mutations for owner PR actions with entity-scoped rollback ([29cc984](https://github.com/alexandre-schaffner/revv/commit/29cc984a418c8f7ed5a8f9f890870d5140d7b9cd))
* **recaps:** chapter rewrite + per-theme summaries + aligned action bars ([#33](https://github.com/alexandre-schaffner/revv/issues/33)) ([ba88ed4](https://github.com/alexandre-schaffner/revv/commit/ba88ed4e1be1c58a266f81930af2079cd39b7f85))
* redesigned score cards ([c0acdea](https://github.com/alexandre-schaffner/revv/commit/c0acdea97b8b25628222db5e191a972e5ccbe44d))
* redesigned score cards ([b4668ff](https://github.com/alexandre-schaffner/revv/commit/b4668ff0e90f2d5ad4a530334a866bdd58a74e85))
* **release:** release-please + Sigstore-signed installer artifacts ([#72](https://github.com/alexandre-schaffner/revv/issues/72)) ([5834195](https://github.com/alexandre-schaffner/revv/commit/58341955a98d18f3a1ea3ad52a28697fbea5deb0))
* relooking ([52ce7fd](https://github.com/alexandre-schaffner/revv/commit/52ce7fd1784fb0c6957865da1e566273c562f992))
* relooking ([61ffd42](https://github.com/alexandre-schaffner/revv/commit/61ffd42a7b2ec2efe07a136fe246516f7f4dd162))
* remote cache ([e817e9c](https://github.com/alexandre-schaffner/revv/commit/e817e9cd4e1a70b38102835bf3b2d243f15a1cf5))
* remote cache ([10cd0d2](https://github.com/alexandre-schaffner/revv/commit/10cd0d2ec6fd26be630fae1deb64d000815f0a77))
* remote cache ([94b030f](https://github.com/alexandre-schaffner/revv/commit/94b030fed61b55b0eab75d9980116d30c1dafab7))
* remove useless files + minor fixes ([0802b54](https://github.com/alexandre-schaffner/revv/commit/0802b54207f65b66739364d52cf99ac449429b70))
* settings ([53dcf2e](https://github.com/alexandre-schaffner/revv/commit/53dcf2e4ca0e156792ee7228e8337a2af4e5c60d))
* switch to GitHub Device Code OAuth flow ([45bc6a6](https://github.com/alexandre-schaffner/revv/commit/45bc6a66bb8f2f84f344315662d821d735c3552b))
* switch to GitHub Device Code OAuth flow ([df58d1b](https://github.com/alexandre-schaffner/revv/commit/df58d1bbcac0fc8e1099c0b619eeb2e21ebb37ce))
* **tabs:** ⌘+number shortcut hints on cmd hold ([#27](https://github.com/alexandre-schaffner/revv/issues/27)) ([14427a0](https://github.com/alexandre-schaffner/revv/commit/14427a0cba3303f23cfc3bcedc21dbac5a4633fe))
* tray app ([6ef5f4d](https://github.com/alexandre-schaffner/revv/commit/6ef5f4d9546b94ea9daea3c2032d1d6bd3b73097))
* use Newsreader font for avatar letter overlay ([1cd9e92](https://github.com/alexandre-schaffner/revv/commit/1cd9e928b472f6bcd1b85c73dbce827d7a90aa71))
* various improvements ([bbdac33](https://github.com/alexandre-schaffner/revv/commit/bbdac33bf913adb30931fb389c49196427f527f2))
* **walkthrough:** shimmer-grouped tool calls + chronological thoughts toggle ([#34](https://github.com/alexandre-schaffner/revv/issues/34)) ([80db63c](https://github.com/alexandre-schaffner/revv/commit/80db63c29b60f9c2e116af5aa9ce7e055ef407b5))
* windows install ([02f409f](https://github.com/alexandre-schaffner/revv/commit/02f409f230ded857ae0f69e8e246c065d3fa47e7))


### Bug Fixes

* agent detection ([c5dbfef](https://github.com/alexandre-schaffner/revv/commit/c5dbfefc0ae50998eb82c95273d6b7d3adf399f0))
* align release-please manifest with actual version (0.0.1) ([12e5f70](https://github.com/alexandre-schaffner/revv/commit/12e5f70485c64920da2ca78c05fcb869f7f6739c))
* avatars ([c8610b8](https://github.com/alexandre-schaffner/revv/commit/c8610b81220303960aaa30023eaacb9fee12a7c7))
* bundled client_id + README update ([c99ed5d](https://github.com/alexandre-schaffner/revv/commit/c99ed5d27ea3607c76cde8301fc2ece1c4a8d3b5))
* chat ([25da7dc](https://github.com/alexandre-schaffner/revv/commit/25da7dc3837f66facf856cb5bb7021a855a9b729))
* chat ([1909156](https://github.com/alexandre-schaffner/revv/commit/190915651c28589dda67aa217fbaa3bd9089e5dd))
* chat ([c7b03e3](https://github.com/alexandre-schaffner/revv/commit/c7b03e33d117d7fa425d192270c4a13d636bda9a))
* ci ([39dc411](https://github.com/alexandre-schaffner/revv/commit/39dc411b43a90997225f7f10251cd81ea68e8039))
* CI ([c7cbd33](https://github.com/alexandre-schaffner/revv/commit/c7cbd33db392ab13ffac1bbe2f52b8960f112b13))
* CI typecheck and lint failures ([d82043c](https://github.com/alexandre-schaffner/revv/commit/d82043cf82d0ba490c4ea1186deaf65c4acbe0ab))
* **ci:** attest discovered tauri bundles ([48234eb](https://github.com/alexandre-schaffner/revv/commit/48234eb3c96b4cebac4d6b46c476a76990195cd7))
* **ci:** format release config output ([c553d3b](https://github.com/alexandre-schaffner/revv/commit/c553d3b9afc9cbd2aaa75487b1ed78f9ab3755c9))
* **ci:** format updater endpoint config ([4f3c2f6](https://github.com/alexandre-schaffner/revv/commit/4f3c2f6fd290bb5c0ec2be607016bcf909b8fd00))
* **ci:** ignore release-managed tauri config formatting ([703e7c5](https://github.com/alexandre-schaffner/revv/commit/703e7c5c89d633db83291bcf23ba594567f580a6))
* **ci:** publish nightly as per-SHA tags to sidestep immutable releases ([#77](https://github.com/alexandre-schaffner/revv/issues/77)) ([99fea12](https://github.com/alexandre-schaffner/revv/commit/99fea12c870da8e776845395dc3385ac342e9f5f))
* **ci:** repair release-please v4 output names + add Tauri upload fallback ([466db2d](https://github.com/alexandre-schaffner/revv/commit/466db2d0aa0b00aa9afe5b7c41cec1472518bf78))
* **ci:** top-level permissions on release & nightly workflows ([#76](https://github.com/alexandre-schaffner/revv/issues/76)) ([97b566e](https://github.com/alexandre-schaffner/revv/commit/97b566e3f46b7f7866304aca10bcec6b0ec380e1))
* **ci:** upload release assets before publishing immutable releases ([58e7ce6](https://github.com/alexandre-schaffner/revv/commit/58e7ce66c3ab5c421a68987392082cb9b35ec8d6))
* **ci:** use existing tauri-action tag ([58c03cd](https://github.com/alexandre-schaffner/revv/commit/58c03cd06b4dbc7feada8f8970cdfce520599de3))
* comments not showing in diff ([67abbb4](https://github.com/alexandre-schaffner/revv/commit/67abbb41cce6d7303a789ffefb59c9f6c923d79d))
* commit sync ([84fd85e](https://github.com/alexandre-schaffner/revv/commit/84fd85edade73a3fabaac2338a5f1f2040054b17))
* **db:** remove fallback account assignment in pre-squash recovery ([4a994ff](https://github.com/alexandre-schaffner/revv/commit/4a994ff606576ee1fa96387885e6bf0a79fc6a8b))
* **db:** repair migration journal so stock drizzle migrator works for every install state ([#24](https://github.com/alexandre-schaffner/revv/issues/24)) ([b974bf4](https://github.com/alexandre-schaffner/revv/commit/b974bf43c5ee0fc6bd90536af8033c28dddf91cb))
* **db:** tighten remoteUsers joins to include provider predicate ([c032995](https://github.com/alexandre-schaffner/revv/commit/c03299589190e0bd15b4c1d4c5ca5d13ce3d446c))
* default gh host ([32cb3b0](https://github.com/alexandre-schaffner/revv/commit/32cb3b086bf058123031cccf6ea0cb5a5ff4f74a))
* **desktop:** use secure updater endpoint ([bba3f1d](https://github.com/alexandre-schaffner/revv/commit/bba3f1d2a8b36cfdfc82fdeada371cdd571d5964))
* duplicate recap content ([88909bd](https://github.com/alexandre-schaffner/revv/commit/88909bd721495e3d1fe9836c3c19aa1a083991e1))
* gc stale walkthrough worktrees, switch to pr-N branches ([9b180e7](https://github.com/alexandre-schaffner/revv/commit/9b180e73a498210b83405fdaadb4d53424db6949))
* harden CORS origin and reject unauthenticated WS connections ([3bc3e1d](https://github.com/alexandre-schaffner/revv/commit/3bc3e1dec7e029eac4c67deb674326dbaf6c329e))
* **identity:** fork avatar upsert to background on /identity cold start ([5e32b6e](https://github.com/alexandre-schaffner/revv/commit/5e32b6e7cd5e2757c9383e5d0bce5709f108283e))
* improve avatar letter contrast with near-white gradient ([dd0bd33](https://github.com/alexandre-schaffner/revv/commit/dd0bd337e6d887844811712353c65b816d03e58e))
* improve loading looks ([b731d3b](https://github.com/alexandre-schaffner/revv/commit/b731d3ba682036f233c5f128f2d0eae6f4f7e532))
* include head commit in PR commits dropdown ([3387d2b](https://github.com/alexandre-schaffner/revv/commit/3387d2b29c6ab2342faa8012c9ef83a3d19c3308))
* install ([a8a5bbf](https://github.com/alexandre-schaffner/revv/commit/a8a5bbf1b716795731daed5784e55fa74a8f91e5))
* install ([e2a59e9](https://github.com/alexandre-schaffner/revv/commit/e2a59e93e0f7cebb759fa41e2b871bdb0790100f))
* install ([3323215](https://github.com/alexandre-schaffner/revv/commit/33232158d3a20838f8a7f41f8fbc15959de362d8))
* install ([9f0c050](https://github.com/alexandre-schaffner/revv/commit/9f0c050e7e413f521ac775911b1d85ae75d92e6c))
* install ([ade0cbf](https://github.com/alexandre-schaffner/revv/commit/ade0cbf760f9b40472a8fb2a4797641fa4f5c6fd))
* install ([7377016](https://github.com/alexandre-schaffner/revv/commit/73770169c7238a51d66a41b3aa04a53617d5b759))
* installation ([d2adc05](https://github.com/alexandre-schaffner/revv/commit/d2adc05e31c9cc129ce2d54b73281bc335ce499c))
* **install:** lowercase PLATFORM via tr for bash 3.2 compatibility ([2d4ee41](https://github.com/alexandre-schaffner/revv/commit/2d4ee414e9c60ace7282726ec10b9a69e2888f5e))
* **install:** use release bundles for desktop app ([b15b661](https://github.com/alexandre-schaffner/revv/commit/b15b661460a2a45b26118557a5e1375dbadde00f))
* **install:** verify workspace deps landed + warn about stale dev DBs ([a24c728](https://github.com/alexandre-schaffner/revv/commit/a24c728ca508747026b231fe6dbdbe53b18ec431))
* **layout:** slide right panel in from outside viewport ([#29](https://github.com/alexandre-schaffner/revv/issues/29)) ([eae034b](https://github.com/alexandre-schaffner/revv/commit/eae034bb0dc4a1c291af0e355c6acd6db5515b0c))
* make avatar letter gradient text fully opaque ([b4bda14](https://github.com/alexandre-schaffner/revv/commit/b4bda14e13f5abdb786b256eaa5634f7043b8276))
* make avatar letter gradient text visible ([2d44d0c](https://github.com/alexandre-schaffner/revv/commit/2d44d0cdd46ad00d6fee10d475a119abf340764b))
* make commits dropdown scrollable ([2110fbb](https://github.com/alexandre-schaffner/revv/commit/2110fbb0d36a0e96c4017cfb781d214b4f998b90))
* minor fixes ([7c9c102](https://github.com/alexandre-schaffner/revv/commit/7c9c102283b5c40da51ab0ddf0fd749b6948b955))
* missing deps ([8f7e0e2](https://github.com/alexandre-schaffner/revv/commit/8f7e0e2489811134a541d6fa06c3db8276ac1f23))
* onboarding ([3d64fbe](https://github.com/alexandre-schaffner/revv/commit/3d64fbea66f13993fe9ec098ee47736e90ba1ac9))
* onboarding ([a92e22a](https://github.com/alexandre-schaffner/revv/commit/a92e22abb32baee396d001ed282bc2afd14acad5))
* onboarding resume, sidebar org filter, empty repo display ([09c4b94](https://github.com/alexandre-schaffner/revv/commit/09c4b946e6c188844a7b742b64a0ad59db3afd7c))
* opencode agent ([c436bd4](https://github.com/alexandre-schaffner/revv/commit/c436bd4a69e9e360cf55bd9e742e5ba132b4e86f))
* pin LOC badge to right edge of file tree on horizontal scroll ([dafefc3](https://github.com/alexandre-schaffner/revv/commit/dafefc33e97c4246251751cac5a90c357a9f3b3e))
* pr fetching ([bd3f835](https://github.com/alexandre-schaffner/revv/commit/bd3f835426f578d56f4e3867a09bc0082988a998))
* PR not taken in account when using in-app merge button ([dff3dae](https://github.com/alexandre-schaffner/revv/commit/dff3dae6eb6d5c68ee1851757f6902e4b86b349c))
* PR not taken in account when using in-app merge button ([85d7f41](https://github.com/alexandre-schaffner/revv/commit/85d7f414907328c69ab74c85dc62f96c059f0bd4))
* prevent walkthrough race conditions and consolidate per-PR state ([f8f970b](https://github.com/alexandre-schaffner/revv/commit/f8f970b45db944ad6cf33363109f9270d8c114af))
* pull button ([3a2102e](https://github.com/alexandre-schaffner/revv/commit/3a2102ef42b9e775eeb881f9ed771bebff2f4169))
* recap ([b309f35](https://github.com/alexandre-schaffner/revv/commit/b309f35ecbd1b81663f0cf8ec289fe828e6e0d93))
* recap ([d14da1d](https://github.com/alexandre-schaffner/revv/commit/d14da1d0f6f9aea2e45256a05b00e236df1292bd))
* **release:** configure release-please root package ([12cbe23](https://github.com/alexandre-schaffner/revv/commit/12cbe23880585ad41ba50577952c13f7a724a355))
* **remote-user:** preserve providerUserId when caller passes empty string ([c386bc6](https://github.com/alexandre-schaffner/revv/commit/c386bc66b0bef4efaf4c26ddf1d45a3ce3319371))
* remove invalid bootstrap-sha input from release-please-action v4 ([f47a5c7](https://github.com/alexandre-schaffner/revv/commit/f47a5c7b1d74ba0c97a8a82f4a5832ea0d2214f6))
* retry/resume walkthrough ([deb7cee](https://github.com/alexandre-schaffner/revv/commit/deb7ceedafb6bdb9061ebf111038693daf0638a7))
* **server:** let setStatus errors propagate instead of swallowing ([fbdb74f](https://github.com/alexandre-schaffner/revv/commit/fbdb74f68ef85ee8e6aac701fe0428987b3747db))
* **server:** recover repos per-account during pre-squash migration ([f6906b8](https://github.com/alexandre-schaffner/revv/commit/f6906b857341219e3f97f77189274e6a457aa0e7))
* sidebar search offset ([#79](https://github.com/alexandre-schaffner/revv/issues/79)) ([e219b7d](https://github.com/alexandre-schaffner/revv/commit/e219b7d7ac21d62a0b2620332de97ed6a39395ed))
* simple vertical gradient text for avatar letters ([4857c7d](https://github.com/alexandre-schaffner/revv/commit/4857c7d902af6fc9ad5c3102560766af313a6e3f))
* small fixes ([9b5203f](https://github.com/alexandre-schaffner/revv/commit/9b5203faa7c3e36494e1762892784c0a78e66195))
* stepper ([f0ea76f](https://github.com/alexandre-schaffner/revv/commit/f0ea76f04f51807ee29ac2d5a92dec039cd96647))
* strengthen avatar letter tint visibility ([6bd6023](https://github.com/alexandre-schaffner/revv/commit/6bd60233ca7755c9656188ca65e2591b31155462))
* strengthen avatar letter visibility ([4baf79e](https://github.com/alexandre-schaffner/revv/commit/4baf79e106af2c248a9eaca8469c859caaf80428))
* timeout during walkthrough generation when using opencode ([2d843ad](https://github.com/alexandre-schaffner/revv/commit/2d843adf1c28ce69fc592cf37f34b9174b39329e))
* typo ([c67f68d](https://github.com/alexandre-schaffner/revv/commit/c67f68d91a36632251aead22d9b3ab0e25947a4a))
* unstable opportunity search ([ec201b8](https://github.com/alexandre-schaffner/revv/commit/ec201b8480aa4503c752251e7075154ad9536bcf))
* use body font for avatar letter overlay ([8311d30](https://github.com/alexandre-schaffner/revv/commit/8311d309c0e7f176b976c98c420ab8c4e53ca60e))
* use mono font for avatar letter overlay ([4817049](https://github.com/alexandre-schaffner/revv/commit/4817049da05c0cadd47cd4280541e1bca2e2d2d3))
* various fixes ([897dd58](https://github.com/alexandre-schaffner/revv/commit/897dd583ea5475dc40680e98ee52d610ae49f893))
* vivid pastel gradient text for avatar letters ([0a68da8](https://github.com/alexandre-schaffner/revv/commit/0a68da81652727aa060aa33a3746ea14e0ae63b8))
* walkthrough concurrency and stale resource cleanup ([273ea46](https://github.com/alexandre-schaffner/revv/commit/273ea46fff061526db1fb4db61aef536780aeedd))
* walkthrough gen false positive timeout ([babbbec](https://github.com/alexandre-schaffner/revv/commit/babbbec0b8b4c906a31139112c3feed6c1516b3c))
* **web:** align sidebar search below header ([#78](https://github.com/alexandre-schaffner/revv/issues/78)) ([215464e](https://github.com/alexandre-schaffner/revv/commit/215464ebfe497459fb9e707ffb16e967aea015b0))
* **web:** extract RAIL_WIDTH to shared constant module ([5192224](https://github.com/alexandre-schaffner/revv/commit/51922242dfc9f5cfefa10a79f3e8282fbc5b54fc))
* **web:** remove dead code from orgs and sidebar stores ([6b7bf39](https://github.com/alexandre-schaffner/revv/commit/6b7bf399d9e52652dea388730073b14955fcf6c2))

## [0.1.1](https://github.com/alexandre-schaffner/revv/compare/v0.1.0...v0.1.1) (2026-05-25)


### Bug Fixes

* **ci:** attest discovered tauri bundles ([48234eb](https://github.com/alexandre-schaffner/revv/commit/48234eb3c96b4cebac4d6b46c476a76990195cd7))
* **ci:** format release config output ([c553d3b](https://github.com/alexandre-schaffner/revv/commit/c553d3b9afc9cbd2aaa75487b1ed78f9ab3755c9))
* **ci:** format updater endpoint config ([4f3c2f6](https://github.com/alexandre-schaffner/revv/commit/4f3c2f6fd290bb5c0ec2be607016bcf909b8fd00))
* **ci:** repair release-please v4 output names + add Tauri upload fallback ([466db2d](https://github.com/alexandre-schaffner/revv/commit/466db2d0aa0b00aa9afe5b7c41cec1472518bf78))
* **ci:** upload release assets before publishing immutable releases ([58e7ce6](https://github.com/alexandre-schaffner/revv/commit/58e7ce66c3ab5c421a68987392082cb9b35ec8d6))
* **ci:** use existing tauri-action tag ([58c03cd](https://github.com/alexandre-schaffner/revv/commit/58c03cd06b4dbc7feada8f8970cdfce520599de3))
* **desktop:** use secure updater endpoint ([bba3f1d](https://github.com/alexandre-schaffner/revv/commit/bba3f1d2a8b36cfdfc82fdeada371cdd571d5964))
* **install:** use release bundles for desktop app ([b15b661](https://github.com/alexandre-schaffner/revv/commit/b15b661460a2a45b26118557a5e1375dbadde00f))
* **install:** verify workspace deps landed + warn about stale dev DBs ([a24c728](https://github.com/alexandre-schaffner/revv/commit/a24c728ca508747026b231fe6dbdbe53b18ec431))
* **release:** configure release-please root package ([12cbe23](https://github.com/alexandre-schaffner/revv/commit/12cbe23880585ad41ba50577952c13f7a724a355))
* sidebar search offset ([#79](https://github.com/alexandre-schaffner/revv/issues/79)) ([e219b7d](https://github.com/alexandre-schaffner/revv/commit/e219b7d7ac21d62a0b2620332de97ed6a39395ed))
* **web:** align sidebar search below header ([#78](https://github.com/alexandre-schaffner/revv/issues/78)) ([215464e](https://github.com/alexandre-schaffner/revv/commit/215464ebfe497459fb9e707ffb16e967aea015b0))

## [0.1.0](https://github.com/alexandre-schaffner/revv/compare/v0.0.1...v0.1.0) (2026-05-25)


### Features

* add Discard and Cherry-pick actions to proposed-changes strip ([9122d56](https://github.com/alexandre-schaffner/revv/commit/9122d56bbce6d9b9b1cf3b417fc75cb323705a35))
* add shimmer on generate changes button ([b0a408e](https://github.com/alexandre-schaffner/revv/commit/b0a408e8679d8af414d3bdd8465f04874964aece))
* auto-update ([01ff498](https://github.com/alexandre-schaffner/revv/commit/01ff4985f7991370a45a882d16ac11b1cf9fe467))
* awesome ui improvements ([8e35d8d](https://github.com/alexandre-schaffner/revv/commit/8e35d8ddc25194767f1da4af43c4ab6d966e737b))
* better walkthrough ([71529ed](https://github.com/alexandre-schaffner/revv/commit/71529edc432f52c4ce216966a6e45d8080646742))
* big clean 2 ([34c10a1](https://github.com/alexandre-schaffner/revv/commit/34c10a15ab350f19add4ed6b475856bd0cc36381))
* big improvements ([3db8847](https://github.com/alexandre-schaffner/revv/commit/3db8847f8cdb9abbb73f072cc3f132a955528dfa))
* bigcleaning ([318a93a](https://github.com/alexandre-schaffner/revv/commit/318a93a1705e5ff5e28750f191d4de8208cfc4e3))
* **cache:** SSHSIG-anchored team cache integrity ([#74](https://github.com/alexandre-schaffner/revv/issues/74)) ([4b9bfae](https://github.com/alexandre-schaffner/revv/commit/4b9bfaef42005951c5d0fd8ee0f3fc4734846147))
* **chat:** float composer over conversation and fix initial textarea sizing ([#25](https://github.com/alexandre-schaffner/revv/issues/25)) ([07ca0cf](https://github.com/alexandre-schaffner/revv/commit/07ca0cfd8eec59d134e514288bd49b1ae3590ecf))
* **chat:** reattach queue + composer on a shared glass surface ([#28](https://github.com/alexandre-schaffner/revv/issues/28)) ([fbab266](https://github.com/alexandre-schaffner/revv/commit/fbab2665d3fb28f459d80b7a76bc16544c7c9856))
* CI ([35298f3](https://github.com/alexandre-schaffner/revv/commit/35298f3e1b99f38e68bce1394f33dc638ab0de40))
* clean pt2 ([c15c45c](https://github.com/alexandre-schaffner/revv/commit/c15c45cdb04d8eef05e0e285e9c77e5c7acc789c))
* full renaming ([28e8103](https://github.com/alexandre-schaffner/revv/commit/28e8103067406fd53ff354ce647e8e866c9b4738))
* gradient text overlay for repo avatars ([ead0618](https://github.com/alexandre-schaffner/revv/commit/ead0618f3328aafa02fb02a51f6db643931383d0))
* instrumentation ([cb15c63](https://github.com/alexandre-schaffner/revv/commit/cb15c63fdac771ec7b665081e9bdcb701ca9b8b6))
* left pane rework ([198e950](https://github.com/alexandre-schaffner/revv/commit/198e950b4c666f9118839e86997174300163f573))
* left pane rework ([d71368e](https://github.com/alexandre-schaffner/revv/commit/d71368e6eb9229540ecdbd8da0765fca375620e3))
* merge button ([001da9b](https://github.com/alexandre-schaffner/revv/commit/001da9b99472cff5e300596f35f077c96edc5a1a))
* merge button ([a26877e](https://github.com/alexandre-schaffner/revv/commit/a26877e6e943fee2904c4e2359a5eefce35a0678))
* merge button ([bb2f39c](https://github.com/alexandre-schaffner/revv/commit/bb2f39c36e114f99d68e96f77e0b9b4d8867bfb9))
* migrate OpenCode provider to @opencode-ai/sdk ([8308745](https://github.com/alexandre-schaffner/revv/commit/83087451737b1d2ba63c1fbcb4e04d9a6ea96456))
* migrate OpenCode provider to @opencode-ai/sdk ([1467877](https://github.com/alexandre-schaffner/revv/commit/14678771aca57a3186cefbdb4575e45e52480fd6))
* multi-account ([871fd11](https://github.com/alexandre-schaffner/revv/commit/871fd110612ecaf20ef4ee2d551eb22a689e3331))
* onoarding ([8c7339c](https://github.com/alexandre-schaffner/revv/commit/8c7339c426586c068b35a5718b430b099bc0f40a))
* owner-hue fluid SVG gradient avatars ([fc37d18](https://github.com/alexandre-schaffner/revv/commit/fc37d18164c883870df33016ce1673419bf42ad3))
* phosphore ([d5037ab](https://github.com/alexandre-schaffner/revv/commit/d5037abe64d749de9f3aa1764143e5fd2eaf6faf))
* pin PRs ([064bb9b](https://github.com/alexandre-schaffner/revv/commit/064bb9baa72371c55abec7d41ce480c288853675))
* **prs:** one-week retention for archived PRs with poll-time backfill ([7097e0d](https://github.com/alexandre-schaffner/revv/commit/7097e0d3ab553dc0f8f58562775e5b70c5950e1f))
* **prs:** one-week retention for archived PRs with poll-time backfill ([d32f4d4](https://github.com/alexandre-schaffner/revv/commit/d32f4d4c3ddcdac63bd2b9114df19639b7373ee9))
* **prs:** optimistic mutations for owner PR actions ([d0b1091](https://github.com/alexandre-schaffner/revv/commit/d0b1091216cd1ad9a7aff9ba3d2d59cbcc4e53c8))
* **prs:** optimistic mutations for owner PR actions with entity-scoped rollback ([29cc984](https://github.com/alexandre-schaffner/revv/commit/29cc984a418c8f7ed5a8f9f890870d5140d7b9cd))
* **recaps:** chapter rewrite + per-theme summaries + aligned action bars ([#33](https://github.com/alexandre-schaffner/revv/issues/33)) ([ba88ed4](https://github.com/alexandre-schaffner/revv/commit/ba88ed4e1be1c58a266f81930af2079cd39b7f85))
* redesigned score cards ([c0acdea](https://github.com/alexandre-schaffner/revv/commit/c0acdea97b8b25628222db5e191a972e5ccbe44d))
* redesigned score cards ([b4668ff](https://github.com/alexandre-schaffner/revv/commit/b4668ff0e90f2d5ad4a530334a866bdd58a74e85))
* **release:** release-please + Sigstore-signed installer artifacts ([#72](https://github.com/alexandre-schaffner/revv/issues/72)) ([5834195](https://github.com/alexandre-schaffner/revv/commit/58341955a98d18f3a1ea3ad52a28697fbea5deb0))
* relooking ([52ce7fd](https://github.com/alexandre-schaffner/revv/commit/52ce7fd1784fb0c6957865da1e566273c562f992))
* relooking ([61ffd42](https://github.com/alexandre-schaffner/revv/commit/61ffd42a7b2ec2efe07a136fe246516f7f4dd162))
* remote cache ([e817e9c](https://github.com/alexandre-schaffner/revv/commit/e817e9cd4e1a70b38102835bf3b2d243f15a1cf5))
* remote cache ([10cd0d2](https://github.com/alexandre-schaffner/revv/commit/10cd0d2ec6fd26be630fae1deb64d000815f0a77))
* remote cache ([94b030f](https://github.com/alexandre-schaffner/revv/commit/94b030fed61b55b0eab75d9980116d30c1dafab7))
* remove useless files + minor fixes ([0802b54](https://github.com/alexandre-schaffner/revv/commit/0802b54207f65b66739364d52cf99ac449429b70))
* settings ([53dcf2e](https://github.com/alexandre-schaffner/revv/commit/53dcf2e4ca0e156792ee7228e8337a2af4e5c60d))
* switch to GitHub Device Code OAuth flow ([45bc6a6](https://github.com/alexandre-schaffner/revv/commit/45bc6a66bb8f2f84f344315662d821d735c3552b))
* switch to GitHub Device Code OAuth flow ([df58d1b](https://github.com/alexandre-schaffner/revv/commit/df58d1bbcac0fc8e1099c0b619eeb2e21ebb37ce))
* **tabs:** ⌘+number shortcut hints on cmd hold ([#27](https://github.com/alexandre-schaffner/revv/issues/27)) ([14427a0](https://github.com/alexandre-schaffner/revv/commit/14427a0cba3303f23cfc3bcedc21dbac5a4633fe))
* tray app ([6ef5f4d](https://github.com/alexandre-schaffner/revv/commit/6ef5f4d9546b94ea9daea3c2032d1d6bd3b73097))
* use Newsreader font for avatar letter overlay ([1cd9e92](https://github.com/alexandre-schaffner/revv/commit/1cd9e928b472f6bcd1b85c73dbce827d7a90aa71))
* various improvements ([bbdac33](https://github.com/alexandre-schaffner/revv/commit/bbdac33bf913adb30931fb389c49196427f527f2))
* **walkthrough:** shimmer-grouped tool calls + chronological thoughts toggle ([#34](https://github.com/alexandre-schaffner/revv/issues/34)) ([80db63c](https://github.com/alexandre-schaffner/revv/commit/80db63c29b60f9c2e116af5aa9ce7e055ef407b5))
* windows install ([02f409f](https://github.com/alexandre-schaffner/revv/commit/02f409f230ded857ae0f69e8e246c065d3fa47e7))


### Bug Fixes

* agent detection ([c5dbfef](https://github.com/alexandre-schaffner/revv/commit/c5dbfefc0ae50998eb82c95273d6b7d3adf399f0))
* align release-please manifest with actual version (0.0.1) ([12e5f70](https://github.com/alexandre-schaffner/revv/commit/12e5f70485c64920da2ca78c05fcb869f7f6739c))
* avatars ([c8610b8](https://github.com/alexandre-schaffner/revv/commit/c8610b81220303960aaa30023eaacb9fee12a7c7))
* bundled client_id + README update ([c99ed5d](https://github.com/alexandre-schaffner/revv/commit/c99ed5d27ea3607c76cde8301fc2ece1c4a8d3b5))
* chat ([25da7dc](https://github.com/alexandre-schaffner/revv/commit/25da7dc3837f66facf856cb5bb7021a855a9b729))
* chat ([1909156](https://github.com/alexandre-schaffner/revv/commit/190915651c28589dda67aa217fbaa3bd9089e5dd))
* chat ([c7b03e3](https://github.com/alexandre-schaffner/revv/commit/c7b03e33d117d7fa425d192270c4a13d636bda9a))
* ci ([39dc411](https://github.com/alexandre-schaffner/revv/commit/39dc411b43a90997225f7f10251cd81ea68e8039))
* CI ([c7cbd33](https://github.com/alexandre-schaffner/revv/commit/c7cbd33db392ab13ffac1bbe2f52b8960f112b13))
* CI typecheck and lint failures ([d82043c](https://github.com/alexandre-schaffner/revv/commit/d82043cf82d0ba490c4ea1186deaf65c4acbe0ab))
* **ci:** attest discovered tauri bundles ([48234eb](https://github.com/alexandre-schaffner/revv/commit/48234eb3c96b4cebac4d6b46c476a76990195cd7))
* **ci:** format updater endpoint config ([4f3c2f6](https://github.com/alexandre-schaffner/revv/commit/4f3c2f6fd290bb5c0ec2be607016bcf909b8fd00))
* **ci:** publish nightly as per-SHA tags to sidestep immutable releases ([#77](https://github.com/alexandre-schaffner/revv/issues/77)) ([99fea12](https://github.com/alexandre-schaffner/revv/commit/99fea12c870da8e776845395dc3385ac342e9f5f))
* **ci:** repair release-please v4 output names + add Tauri upload fallback ([466db2d](https://github.com/alexandre-schaffner/revv/commit/466db2d0aa0b00aa9afe5b7c41cec1472518bf78))
* **ci:** top-level permissions on release & nightly workflows ([#76](https://github.com/alexandre-schaffner/revv/issues/76)) ([97b566e](https://github.com/alexandre-schaffner/revv/commit/97b566e3f46b7f7866304aca10bcec6b0ec380e1))
* **ci:** upload release assets before publishing immutable releases ([58e7ce6](https://github.com/alexandre-schaffner/revv/commit/58e7ce66c3ab5c421a68987392082cb9b35ec8d6))
* **ci:** use existing tauri-action tag ([58c03cd](https://github.com/alexandre-schaffner/revv/commit/58c03cd06b4dbc7feada8f8970cdfce520599de3))
* comments not showing in diff ([67abbb4](https://github.com/alexandre-schaffner/revv/commit/67abbb41cce6d7303a789ffefb59c9f6c923d79d))
* commit sync ([84fd85e](https://github.com/alexandre-schaffner/revv/commit/84fd85edade73a3fabaac2338a5f1f2040054b17))
* **db:** remove fallback account assignment in pre-squash recovery ([4a994ff](https://github.com/alexandre-schaffner/revv/commit/4a994ff606576ee1fa96387885e6bf0a79fc6a8b))
* **db:** repair migration journal so stock drizzle migrator works for every install state ([#24](https://github.com/alexandre-schaffner/revv/issues/24)) ([b974bf4](https://github.com/alexandre-schaffner/revv/commit/b974bf43c5ee0fc6bd90536af8033c28dddf91cb))
* **db:** tighten remoteUsers joins to include provider predicate ([c032995](https://github.com/alexandre-schaffner/revv/commit/c03299589190e0bd15b4c1d4c5ca5d13ce3d446c))
* default gh host ([32cb3b0](https://github.com/alexandre-schaffner/revv/commit/32cb3b086bf058123031cccf6ea0cb5a5ff4f74a))
* **desktop:** use secure updater endpoint ([bba3f1d](https://github.com/alexandre-schaffner/revv/commit/bba3f1d2a8b36cfdfc82fdeada371cdd571d5964))
* duplicate recap content ([88909bd](https://github.com/alexandre-schaffner/revv/commit/88909bd721495e3d1fe9836c3c19aa1a083991e1))
* gc stale walkthrough worktrees, switch to pr-N branches ([9b180e7](https://github.com/alexandre-schaffner/revv/commit/9b180e73a498210b83405fdaadb4d53424db6949))
* harden CORS origin and reject unauthenticated WS connections ([3bc3e1d](https://github.com/alexandre-schaffner/revv/commit/3bc3e1dec7e029eac4c67deb674326dbaf6c329e))
* **identity:** fork avatar upsert to background on /identity cold start ([5e32b6e](https://github.com/alexandre-schaffner/revv/commit/5e32b6e7cd5e2757c9383e5d0bce5709f108283e))
* improve avatar letter contrast with near-white gradient ([dd0bd33](https://github.com/alexandre-schaffner/revv/commit/dd0bd337e6d887844811712353c65b816d03e58e))
* improve loading looks ([b731d3b](https://github.com/alexandre-schaffner/revv/commit/b731d3ba682036f233c5f128f2d0eae6f4f7e532))
* include head commit in PR commits dropdown ([3387d2b](https://github.com/alexandre-schaffner/revv/commit/3387d2b29c6ab2342faa8012c9ef83a3d19c3308))
* install ([a8a5bbf](https://github.com/alexandre-schaffner/revv/commit/a8a5bbf1b716795731daed5784e55fa74a8f91e5))
* install ([e2a59e9](https://github.com/alexandre-schaffner/revv/commit/e2a59e93e0f7cebb759fa41e2b871bdb0790100f))
* install ([3323215](https://github.com/alexandre-schaffner/revv/commit/33232158d3a20838f8a7f41f8fbc15959de362d8))
* install ([9f0c050](https://github.com/alexandre-schaffner/revv/commit/9f0c050e7e413f521ac775911b1d85ae75d92e6c))
* install ([ade0cbf](https://github.com/alexandre-schaffner/revv/commit/ade0cbf760f9b40472a8fb2a4797641fa4f5c6fd))
* install ([7377016](https://github.com/alexandre-schaffner/revv/commit/73770169c7238a51d66a41b3aa04a53617d5b759))
* installation ([d2adc05](https://github.com/alexandre-schaffner/revv/commit/d2adc05e31c9cc129ce2d54b73281bc335ce499c))
* **install:** lowercase PLATFORM via tr for bash 3.2 compatibility ([2d4ee41](https://github.com/alexandre-schaffner/revv/commit/2d4ee414e9c60ace7282726ec10b9a69e2888f5e))
* **install:** use release bundles for desktop app ([b15b661](https://github.com/alexandre-schaffner/revv/commit/b15b661460a2a45b26118557a5e1375dbadde00f))
* **install:** verify workspace deps landed + warn about stale dev DBs ([a24c728](https://github.com/alexandre-schaffner/revv/commit/a24c728ca508747026b231fe6dbdbe53b18ec431))
* **layout:** slide right panel in from outside viewport ([#29](https://github.com/alexandre-schaffner/revv/issues/29)) ([eae034b](https://github.com/alexandre-schaffner/revv/commit/eae034bb0dc4a1c291af0e355c6acd6db5515b0c))
* make avatar letter gradient text fully opaque ([b4bda14](https://github.com/alexandre-schaffner/revv/commit/b4bda14e13f5abdb786b256eaa5634f7043b8276))
* make avatar letter gradient text visible ([2d44d0c](https://github.com/alexandre-schaffner/revv/commit/2d44d0cdd46ad00d6fee10d475a119abf340764b))
* make commits dropdown scrollable ([2110fbb](https://github.com/alexandre-schaffner/revv/commit/2110fbb0d36a0e96c4017cfb781d214b4f998b90))
* minor fixes ([7c9c102](https://github.com/alexandre-schaffner/revv/commit/7c9c102283b5c40da51ab0ddf0fd749b6948b955))
* missing deps ([8f7e0e2](https://github.com/alexandre-schaffner/revv/commit/8f7e0e2489811134a541d6fa06c3db8276ac1f23))
* onboarding ([3d64fbe](https://github.com/alexandre-schaffner/revv/commit/3d64fbea66f13993fe9ec098ee47736e90ba1ac9))
* onboarding ([a92e22a](https://github.com/alexandre-schaffner/revv/commit/a92e22abb32baee396d001ed282bc2afd14acad5))
* onboarding resume, sidebar org filter, empty repo display ([09c4b94](https://github.com/alexandre-schaffner/revv/commit/09c4b946e6c188844a7b742b64a0ad59db3afd7c))
* opencode agent ([c436bd4](https://github.com/alexandre-schaffner/revv/commit/c436bd4a69e9e360cf55bd9e742e5ba132b4e86f))
* pin LOC badge to right edge of file tree on horizontal scroll ([dafefc3](https://github.com/alexandre-schaffner/revv/commit/dafefc33e97c4246251751cac5a90c357a9f3b3e))
* pr fetching ([bd3f835](https://github.com/alexandre-schaffner/revv/commit/bd3f835426f578d56f4e3867a09bc0082988a998))
* PR not taken in account when using in-app merge button ([dff3dae](https://github.com/alexandre-schaffner/revv/commit/dff3dae6eb6d5c68ee1851757f6902e4b86b349c))
* PR not taken in account when using in-app merge button ([85d7f41](https://github.com/alexandre-schaffner/revv/commit/85d7f414907328c69ab74c85dc62f96c059f0bd4))
* prevent walkthrough race conditions and consolidate per-PR state ([f8f970b](https://github.com/alexandre-schaffner/revv/commit/f8f970b45db944ad6cf33363109f9270d8c114af))
* pull button ([3a2102e](https://github.com/alexandre-schaffner/revv/commit/3a2102ef42b9e775eeb881f9ed771bebff2f4169))
* recap ([b309f35](https://github.com/alexandre-schaffner/revv/commit/b309f35ecbd1b81663f0cf8ec289fe828e6e0d93))
* recap ([d14da1d](https://github.com/alexandre-schaffner/revv/commit/d14da1d0f6f9aea2e45256a05b00e236df1292bd))
* **release:** configure release-please root package ([12cbe23](https://github.com/alexandre-schaffner/revv/commit/12cbe23880585ad41ba50577952c13f7a724a355))
* **remote-user:** preserve providerUserId when caller passes empty string ([c386bc6](https://github.com/alexandre-schaffner/revv/commit/c386bc66b0bef4efaf4c26ddf1d45a3ce3319371))
* remove invalid bootstrap-sha input from release-please-action v4 ([f47a5c7](https://github.com/alexandre-schaffner/revv/commit/f47a5c7b1d74ba0c97a8a82f4a5832ea0d2214f6))
* retry/resume walkthrough ([deb7cee](https://github.com/alexandre-schaffner/revv/commit/deb7ceedafb6bdb9061ebf111038693daf0638a7))
* **server:** let setStatus errors propagate instead of swallowing ([fbdb74f](https://github.com/alexandre-schaffner/revv/commit/fbdb74f68ef85ee8e6aac701fe0428987b3747db))
* **server:** recover repos per-account during pre-squash migration ([f6906b8](https://github.com/alexandre-schaffner/revv/commit/f6906b857341219e3f97f77189274e6a457aa0e7))
* sidebar search offset ([#79](https://github.com/alexandre-schaffner/revv/issues/79)) ([e219b7d](https://github.com/alexandre-schaffner/revv/commit/e219b7d7ac21d62a0b2620332de97ed6a39395ed))
* simple vertical gradient text for avatar letters ([4857c7d](https://github.com/alexandre-schaffner/revv/commit/4857c7d902af6fc9ad5c3102560766af313a6e3f))
* small fixes ([9b5203f](https://github.com/alexandre-schaffner/revv/commit/9b5203faa7c3e36494e1762892784c0a78e66195))
* stepper ([f0ea76f](https://github.com/alexandre-schaffner/revv/commit/f0ea76f04f51807ee29ac2d5a92dec039cd96647))
* strengthen avatar letter tint visibility ([6bd6023](https://github.com/alexandre-schaffner/revv/commit/6bd60233ca7755c9656188ca65e2591b31155462))
* strengthen avatar letter visibility ([4baf79e](https://github.com/alexandre-schaffner/revv/commit/4baf79e106af2c248a9eaca8469c859caaf80428))
* timeout during walkthrough generation when using opencode ([2d843ad](https://github.com/alexandre-schaffner/revv/commit/2d843adf1c28ce69fc592cf37f34b9174b39329e))
* typo ([c67f68d](https://github.com/alexandre-schaffner/revv/commit/c67f68d91a36632251aead22d9b3ab0e25947a4a))
* unstable opportunity search ([ec201b8](https://github.com/alexandre-schaffner/revv/commit/ec201b8480aa4503c752251e7075154ad9536bcf))
* use body font for avatar letter overlay ([8311d30](https://github.com/alexandre-schaffner/revv/commit/8311d309c0e7f176b976c98c420ab8c4e53ca60e))
* use mono font for avatar letter overlay ([4817049](https://github.com/alexandre-schaffner/revv/commit/4817049da05c0cadd47cd4280541e1bca2e2d2d3))
* various fixes ([897dd58](https://github.com/alexandre-schaffner/revv/commit/897dd583ea5475dc40680e98ee52d610ae49f893))
* vivid pastel gradient text for avatar letters ([0a68da8](https://github.com/alexandre-schaffner/revv/commit/0a68da81652727aa060aa33a3746ea14e0ae63b8))
* walkthrough concurrency and stale resource cleanup ([273ea46](https://github.com/alexandre-schaffner/revv/commit/273ea46fff061526db1fb4db61aef536780aeedd))
* walkthrough gen false positive timeout ([babbbec](https://github.com/alexandre-schaffner/revv/commit/babbbec0b8b4c906a31139112c3feed6c1516b3c))
* **web:** align sidebar search below header ([#78](https://github.com/alexandre-schaffner/revv/issues/78)) ([215464e](https://github.com/alexandre-schaffner/revv/commit/215464ebfe497459fb9e707ffb16e967aea015b0))
* **web:** extract RAIL_WIDTH to shared constant module ([5192224](https://github.com/alexandre-schaffner/revv/commit/51922242dfc9f5cfefa10a79f3e8282fbc5b54fc))
* **web:** remove dead code from orgs and sidebar stores ([6b7bf39](https://github.com/alexandre-schaffner/revv/commit/6b7bf399d9e52652dea388730073b14955fcf6c2))
