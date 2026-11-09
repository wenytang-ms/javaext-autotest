import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

interface LanguagePackManifest {
  publisher: string;
  name: string;
  version: string;
  __metadata?: { id?: string };
  contributes?: {
    localizations?: Array<{
      languageId: string;
      languageName?: string;
      localizedLanguageName?: string;
      translations: Array<{ id: string; path: string }>;
    }>;
  };
}

/**
 * CLI installs do not always populate VS Code's native language-pack registry.
 * Prepare it only in the owned profile; VS Code still generates and loads NLS.
 */
export function prepareLanguagePack(userDataDir: string, extensionsDir: string, locale: string): void {
  if (locale === "en") return;
  const translations: Record<string, string> = {};
  const extensions: Array<{ extensionIdentifier: { id: string; uuid?: string }; version: string }> = [];
  const hash = createHash("md5");
  let label = locale;
  for (const entry of fs.existsSync(extensionsDir) ? fs.readdirSync(extensionsDir, { withFileTypes: true }) : []) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(extensionsDir, entry.name);
    const manifestPath = path.join(directory, "package.json");
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as LanguagePackManifest;
    const localization = manifest.contributes?.localizations?.find(item => item.languageId.toLowerCase() === locale);
    if (!localization) continue;
    if (!manifest.publisher || !manifest.name || !manifest.version || !Array.isArray(localization.translations)) {
      throw new Error(`Invalid installed language pack manifest: ${manifestPath}`);
    }
    const id = `${manifest.publisher}.${manifest.name}`.toLowerCase();
    const uuid = manifest.__metadata?.id;
    extensions.push({ extensionIdentifier: { id, ...(uuid ? { uuid } : {}) }, version: manifest.version });
    hash.update(uuid ?? id).update(manifest.version);
    label = localization.localizedLanguageName ?? localization.languageName ?? locale;
    for (const translation of localization.translations) {
      if (typeof translation.id !== "string" || !translation.id || typeof translation.path !== "string") {
        throw new Error(`Invalid translation entry in ${manifestPath}`);
      }
      const file = path.resolve(directory, translation.path);
      if (!fs.statSync(file).isFile()) throw new Error(`Language pack translation is not a file: ${file}`);
      if (translations[translation.id] && translations[translation.id] !== file) {
        throw new Error(`Multiple installed language packs provide ${translation.id} for ${locale}`);
      }
      translations[translation.id] = file;
    }
  }
  if (!translations.vscode) {
    throw new Error(`No installed language pack provides VS Code locale ${locale}. Add the matching language pack to extensions or vsix.`);
  }
  fs.writeFileSync(path.join(userDataDir, "languagepacks.json"), JSON.stringify({
    [locale]: { hash: hash.digest("hex"), extensions, translations, label },
  }), "utf8");
}
