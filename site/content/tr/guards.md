---
title: Korumalar
description: Buracle Stack hook'larının neleri reddettiği, neleri önce sana sorduğu, neleri maskelediği ve kendi kalıplarını nasıl ekleyeceğin.
order: 6
---

Buracle Stack her harness'ı onay penceresi açmadan çalışacak şekilde ayarlar (`permissions.bypass`) ve korumayı her araç çağrısından önce çalışan hook'lara bırakır. Bir ret mesajı `Buracle Stack H<nn>:` ile başlar, buradaki numara çağrıyı reddeden hook'u gösterir.

## Reddedilen komutlar

Shell koruması (H01) geri alınamayan komutları reddeder:

- `/`, bir sistem klasörü, `~` ya da `~/Documents` veya `~/.ssh` gibi bir ev klasörü üzerinde `rm -rf`
- `main` ya da `master` dalına force push, mirror push ya da bu dalları silmek
- indirilen bir dosyayı doğrudan shell'e aktarmak (`curl ... | sh`)
- `mkfs`, bir aygıta `dd` ve `diskutil` ile disk silmek
- fork bomb, bütün süreçleri öldürmek, `crontab -r` ve `gh repo delete`

Koruma `sudo`, `env`, `sh -c`, `find -exec` gibi sarmalayıcıların ve bir yorumlayıcıya verilen kodun içine bakar. Sonuna kadar izleyemediği bir komutu reddeder.

## Reddedilen yazmalar

Yazma koruması (H02) şu yerlere yazmayı reddeder:

- gizli bilgiler: `.env` dosyaları, anahtarlar ve kimlik bilgileri
- `~/.ssh`, `~/.aws` ve `~/.gnupg`
- `~/.netrc`, `~/.npmrc` ve `~/.docker/config.json` gibi kimlik bilgisi depoları
- Buracle Stack'in kurulum dosyaları: `~/.buracle` ve hook'larını kaydeden harness ayarları

## Yalnızca senin çalıştırabileceğin komutlar

Ajan Buracle Stack'i kapatamaz. Shell koruması, ajan çalıştırdığında şu komutları reddeder:

- `buracle uninstall`
- korumalar, izinler, harness'lar, yönlendirme, durdurma koruması ve onay, inceleme, doğrulama anahtarları için `buracle config set` ya da `unset`
- Buracle Stack'in harness eklentisini kaldıran ya da devre dışı bırakan bir komut

Bunları kendin çalıştır: bir terminalde ya da harness içinde `! <command>` olarak.

## Önce sorulanlar

Geri alması zor komutlar senin yanıtını bekler (H20):

| Tür | Örnekler |
|---|---|
| Force push | `git push --force`, `git push --force-with-lease` |
| Git geçmişini yeniden yazmak | `git reset --hard`, `git rebase`, `git commit --amend` |
| Commit edilmemiş değişiklikleri atmak | `git checkout -- <path>`, `git restore <path>`, `git clean -f`, `git stash drop` |
| Dal ya da etiket silmek | `git branch -D`, `git tag -d`, `git push --delete` |
| Git hook'larını atlamak | `git commit --no-verify` |
| Bir remote'a push etmek | `git push` |
| Bu bilgisayarın dışına yayımlamak | `npm publish`, `cargo publish`, `gh release create`, `gh pr merge`, `docker push` |
| Veri tabanı verisini silmek | `dropdb`, `prisma migrate reset`, `rails db:drop`, bir SQL istemcisinde `DROP TABLE` |
| Bir klasör ağacını silmek | `node_modules` ya da `dist` gibi bir derleme veya önbellek klasörü olmayan bir klasör üzerinde `rm -r` |

Harness'ın bir penceresi varsa komut orada bekler. Claude Code'da Allow once, Allow for this session ya da Refuse seçeneklerinden birini seçersin. Codex yerleşik onay istemini gösterir. OpenCode TUI içinde bir pencere açar, Oh My Pi ve Pi ise bir seçim penceresi gösterir.

Qwen Code ve AGY CLI'da, ayrıca `codex exec` gibi penceresi olmayan oturumlarda ret mesajı ajana sana sormasını söyler. Komuta izin vermek için "evet", "tamam", "yes", "ok" ya da "go ahead" diye yanıt ver. Her durum [harness sınırlarında](harnesses.md#harness-sınırları) listelenir.

## Maskeleme

Anahtarlar, token'lar ve parolalar araçların döndürdüğü çıktıda (dosya okumaları, shell çıktısı, arama sonuçları ve MCP sonuçları) model onları okumadan önce maskelenir. Bu davranışı `guards.redact` yönetir, varsayılan değeri `true`. Codex'te [harness sınırlarında](harnesses.md#harness-sınırları) yazan iki açık kalır: çalışan bir komutun canlı çıktısı ve başarısız bir MCP çağrısının çıktısı.

## Bir hook bozulduğunda

Korumalar bozulduğunda çağrıya izin vermez. Diğer bütün hook'lar ise işin sürmesine izin verip hatayı `~/.buracle/logs/buracle.log` dosyasına yazar.

- Claude Code, Codex, Qwen Code ve AGY CLI'da hook'lar ayrı komutlar olarak çalışır. Koruma hook'u yüklenemez ya da karar veremezse Buracle Stack yeniden çalışana kadar korunan her araç çağrısı reddedilir. Ret mesajı senden önce `buracle doctor`, ardından `buracle install` çalıştırmanı ister.
- OpenCode, Oh My Pi ve Pi hook'ları harness'ın içinde çalıştırır. Bu harness'larda shell koruması ya da yazma koruması bozulursa çağrı reddedilir.

## Kendi kalıpların

Kalıpları `~/.buracle/config.yaml` dosyasına ekle:

```yaml
guards:
  bash:
    extraDeny:
      - "terraform destroy"
  write:
    protect:
      - "infra/prod/**"
      - "~/notes/*.md"
```

- `guards.bash.extraDeny` komut metniyle eşleştirilen düzenli ifadeler alır. `/pattern/flags` biçimi de geçerlidir. Eşleşen komut reddedilir ve ajana önce sana sorması söylenir.
- `guards.write.protect` glob'lar alır. `~` ya da `/` ile başlayan kalıp mutlak yoldur. İçinde `/` geçen kalıp oturumun klasörüne göre okunur. Yalın bir ad, her yerdeki aynı adlı dosyayla eşleşir. Eşleştirmede büyük ve küçük harf ayrımı yapılmaz.
