# Updating the AlertPage extension

## First time (once)

1. Delete the old AlertPage zip and the old extracted folder. In `chrome://extensions`, click **Remove** on AlertPage Working Screen Assist.
2. Make a folder `C:\AlertPage` and put `Update AlertPage.bat` and `update-alertpage.ps1` in it.
3. Double-click `Update AlertPage.bat`. It downloads and installs the extension into `C:\AlertPage\extension`.
4. In `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, pick `C:\AlertPage\extension`.
5. Click the extension icon and type your ID in **Your ID** (your toggles and note pills start fresh too).

## How to update

1. Double-click `Update AlertPage.bat`.
2. Wait until it says **Now click the reload button on the AlertPage extension**.
3. Open `chrome://extensions` and click the reload arrow on **AlertPage Working Screen Assist**.
4. Reload the AlertPage tab.

If Windows says "Windows protected your PC" (SmartScreen), click **More info**, then **Run anyway**.

If the window shows an error in red, nothing was changed. Check your internet and try again.

## Rollback

The updater always installs the newest release. To go back: download the previous release's zip from the repo's Releases page (github.com/Sujatx/alertpage-extension/releases), unzip it, replace everything inside `C:\AlertPage\extension` with the unzipped files, and click reload on the extension. Or ask the maintainer to re-publish the previous version as the latest release, then run the updater.

## For the maintainer: publishing a release

1. Bump `version` in `extension/manifest.json`, then run `node tools/build-release.mjs`.
2. Create a GitHub release on `Sujatx/alertpage-extension`, mark it **Latest**.
3. Attach both files from `dist/`, with exactly these names: `alertpage-extension.zip` and `alertpage-extension.zip.sha256`.
