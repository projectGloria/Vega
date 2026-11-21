# GloriaSetup rollout for Vega

Added `gloria.toml` and `.github/workflows/release.yml`. Push a tag like `v1.2.0` to build and attach `Vega_1.2.0_x64-setup.exe`. Nothing was built or pushed locally.

## Please check

- **Main exe / names:** the Electron `productName` is `VideoDownloader` (and `app.setName('VideoDownloader')`), so `main_exe` is `VideoDownloader.exe` and settings live in `%APPDATA%\VideoDownloader` (userData). If you rename the app to Vega, update `main_exe` and `data_folders`.
- **Version:** `gloria.toml` has `1.0.0` from `package.json` (the catalog says 0.3.2). The tag overrides it when releasing.
- **Legacy names:** I could not tell whether an NSIS build ever shipped. `legacy_names` lists `VideoDownloader` and `Video Downloader` (the NSIS shortcut name) to be safe; remove them if no installer was published.
- **App folder:** `app-dist/` is the whole `dist/win-unpacked` output of `electron-builder --dir`, which is what Electron needs at runtime (exe, dlls, `resources/app.asar`, `icon.ico`, unpacked yauzl).
- **Icon:** `resources/icon.ico` (no `Vega.ico` exists).
- **Signing:** the `WINDOWS_PFX_BASE64` and `WINDOWS_PFX_PASSWORD` secrets must exist, otherwise the setup is unsigned.
- **WebView2:** not needed (Electron), so no bootstrapper.
- **electron-builder.yml** still has NSIS/portable targets; the workflow does not use them and they are untouched.
