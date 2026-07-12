'use strict';

/**
 * macOS ad-hoc code signing (afterPack hook).
 *
 * Sorun: CI'da gerçek Apple Developer sertifikamız yok (CSC_IDENTITY_AUTO_DISCOVERY=false).
 * macOS 15 Sequoia, internetten indirilen TAMAMEN imzasız uygulamaları "hasar görmüş"
 * (damaged) diye işaretleyip açmayı reddediyor.
 *
 * Çözüm: uygulamayı **ad-hoc** imzala (`codesign --sign -`). Ad-hoc imza bir geliştirici
 * kimliği doğrulamaz (Gatekeeper "tanımlanmış geliştirici" demez) AMA macOS'a "bu app
 * kasıtlı/bütünlüğü sağlam" der → "damaged" hatası çıkmaz. Apple sertifikası ($99/yıl)
 * GEREKMEZ. Kullanıcı ilk açışta yine sağ tık → Aç (veya System Settings → Open Anyway)
 * diyebilir; ama "hasar görmüş" hatası ortadan kalkar.
 *
 * afterPack, .app paketlendikten SONRA ama .dmg oluşturulmadan ÖNCE çalışır → imzaladığımız
 * app doğrudan dmg'nin içine girer. CSC_IDENTITY_AUTO_DISCOVERY=false olduğundan
 * electron-builder kendi imzalama adımını atlar, ad-hoc imzamız korunur.
 */
const path = require('path');
const { execFileSync } = require('child_process');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return; // yalnız macOS

  const appName = context.packager.appInfo.productFilename; // "Cupertino Terminal"
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  console.log(`[afterPack] macOS ad-hoc imzalama: ${appPath}`);
  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
    console.log('[afterPack] ad-hoc imzalama tamam.');
  } catch (err) {
    // İmzalama başarısızsa build'i kırma (ör. macOS dışı runner) — sadece uyar.
    throw new Error(`[afterPack] ad-hoc imzalama başarısız: ${err.message}`);
  }
};
