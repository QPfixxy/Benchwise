# Releasing Benchwise

## Cutting a release

```bash
npm version minor        # or patch / major: bumps package.json, commits and tags
git push --follow-tags
```

The **Release** workflow then:

- builds Windows, macOS and Linux;
- smoke-tests and UI-checks each packaged app on its own OS;
- fails if the packaged app doesn't contain its own smartctl;
- attaches the files to a **draft** GitHub release.

Review the draft, add release notes, and click **Publish**. The workflow refuses a tag that doesn't match the `package.json` version.

**Test builds without publishing:** run **Actions → Release → Run workflow**. The builds appear as artifacts on that run.

**Local builds:** run `npm run vendor:smartctl` first, so the build includes smartctl. Then `npm run dist:win`, `npm run dist:mac` or `npm run dist:linux`, with output in `dist/`. Build each platform on its own OS. For a Mac build without the signing certificate, use `npm run dist:mac:unsigned`.

## Mac signing and notarization (one-time setup)

Without this, the Mac build is self-signed, and testers must right-click → **Open** the first time. With it, the app opens normally on any Mac. You need a paid Apple Developer account with the **Account Holder** or **Admin** role.

1. **Create a Developer ID certificate.** In Xcode, go to Settings → Accounts, select your team → **Manage Certificates** → **+** → **Developer ID Application**. An "Apple Development" certificate won't work: it's only trusted for apps you run yourself.
2. **Export it.** In Keychain Access → *My Certificates*, right-click **Developer ID Application: …** → Export, and save it as a `.p12` with a password. Then copy it as base64: `base64 -i DeveloperID.p12 | pbcopy`
3. **Create a notarization API key.** In [App Store Connect](https://appstoreconnect.apple.com), go to Users and Access → Integrations → App Store Connect API → Team Keys → **+**, with *Developer* access. Download the `AuthKey_XXXXXX.p8` file, which can only be downloaded once. Note the **Key ID** and **Issuer ID**.
4. **Add five repository secrets** in GitHub → repo Settings → Secrets and variables → Actions:

   | Secret | Value |
   |---|---|
   | `MAC_CERT_P12_BASE64` | the base64 text from step 2 |
   | `MAC_CERT_PASSWORD` | the `.p12` password |
   | `APPLE_API_KEY_P8` | the full contents of the `.p8` file |
   | `APPLE_API_KEY_ID` | the Key ID |
   | `APPLE_API_ISSUER` | the Issuer ID |

5. Run **Actions → Release → Run workflow**. The *Verify Mac signature* step should show your Developer ID and `source=Notarized Developer ID`. Notarization adds a few minutes to each Mac build.
