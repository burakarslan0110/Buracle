---
title: Hafıza
description: Ortak hafızanın nasıl çalıştığı, bir oturumun neyi yükleyip neyi kaydettiği, yedeklerin nasıl alındığı ve hafızanın dışında neyin nasıl tutulacağı.
order: 4
---

Bütün harness'lar aynı hafızayı paylaşır. Bu hafıza tek bir [CortexDB](https://github.com/liliang-cn/cortexdb) dosyasıdır: `~/.buracle/brain/brain.db`. İçinde her proje için bir kova, bir de sana ait kova (kişi beyni) bulunur. Her harness hafızaya `buracle-memory` MCP sunucusu üzerinden ulaşır ve bir oturum yalnızca o anki projenin kovasını ve seninkini görür. Codex'te kaydedilen bir karar, aynı projeyi Claude Code'da açtığında da oradadır.

## Oturum neyle başlar

Oturum açıldığında ajan şunları alır:

- kişi beyninden tercihlerin,
- projenin en önemli hafızaları,
- aynı dalda yarım kalan iş son 24 saat içindeyse bir devir notu,
- hafızada bir sorun varsa bir sağlık satırı.

Bu başlangıç metni hazırlanırken hafıza yalnızca okunur. Hiçbir süreç başlatılmaz, hiçbir şey yazılmaz.

## Neler kaydedilir

- Kalıcı bir kural olarak söylediğin tercih ("her zaman", "asla", "bundan sonra") hemen ve senin sözlerinle kaydedilir.
- Harness bir konuşmayı sıkıştırmadan önce plan ve todo durumu bir devir hafızasına yazılır. Sonraki tur işi buradan sürdürür.
- Oturum bitince `buracle mem finalize` bir kez çalışıp oturum hafızasını yazar. Ardından kullandığın harness'ın modelinden saklamaya değer kararları, tuzakları, prosedürleri ve tercihleri ister.
- Güvenilir bulgular çıkarım olarak kaydedilir, geri kalanı daha sonra dosyalanmak üzere yakalama olarak bekler. Bir bulgu senin yazdığın bir hafızayı hiçbir zaman değiştirmez. Onun yanına konur ve çelişen diye işaretlenir.
- `/remember <text>` elle bir yakalama kaydeder.

Oturum sonundaki işi istediğin anda yaptırmak için `buracle mem capture`, yakalaması hâlâ bekleyen oturumları görmek için `buracle mem doctor` çalıştır. Arka planda başka bir şey çalışmaz.

## Hafıza grafiği

Hafızalar birbirine ve koduna bağlıdır, bu yüzden hafıza bir liste olduğu kadar bir grafiktir. Her hafıza `sources` alanında andığı dosyalara, `about` alanındaki konulara ve etiketlerine bağlanır. Başka hafızalara da bağlanır: yerini aldığı hafızaya (supersedes), aynı fikirde olmadığı ve yanına kaydedildiği hafızaya (contradicts), kimliğini andığı hafızaya ve metni yeterince yakın olan benzer hafızalara.

Ajanlar arama yaparken bu bağları kullanır:

| Arama | Ne bulur |
|---|---|
| `files: ["src/billing/total.ts"]` ile `memory_search` | Dosyayı ya da klasörünü anan her hafızayı, sorgu yazmadan |
| `about: ["CortexDB"]` ile `memory_search` | Bir konudaki hafızaları ve kelimeleri farklı olsa da o konuya bağlı hafızaları |
| `around: <id>` ile `memory_search` | Aynı beynin bir hafızadan hemen önce ve hemen sonra kaydettiklerini |

[Buracle Stack Konsolu](console.md) aynı grafiği çizer. Ağ görünümü için `G` tuşuna bas ya da `1` ile `7` arasındaki tuşlarla bir bölge aç. Bölgenin hafızaları paylaştıkları dosyalar, etiketler ve konularla, bağlandıkları diğer bölgelerin hafızalarıyla birlikte görünür. Bir düğüm, hafızanın önemiyle ve ajanların onu ne sıklıkla hatırladığıyla büyür.

## Hafızalar ne kadar kalır

| Hafıza | Saklama süresi |
|---|---|
| Oturum hafızaları | 45 gün |
| Devir notları | 14 gün |
| Kararlar, tuzaklar, prosedürler, bilgiler, tercihler | Sen emekli edene ya da silene kadar |

Her hafızayı [Konsol](console.md) üzerinden düzenleyebilir, emekli edebilir, geri getirebilir ya da silebilirsin.

## Yedekler

- `buracle mem backup`, beyin dosyasının tamamını `~/.buracle/brain/backups/<id>/` içine kopyalar ve en yeni 10 kopyayı tutar.
- Bir oturum bittiğinde en yeni yedek bir günden eskiyse bir kopya daha alınır.
- `buracle mem backup --list` yedekleri en yeniden başlayarak, her birinin içerdiği kovalarla birlikte gösterir.
- `buracle mem restore <id> --all` dosyanın tamamını geri koyar. `--project <slug>` ya da `--person` yalnızca bir kovayı geri yükler, diğerlerine dokunmaz.

Geri yükleme önce mevcut beyni ayrı bir yedek olarak saklar. Beyin senin bilgisayarında kalır, hiçbir yere eşitlenmez.

## Model çağrıları ve kullanım sınırları

Oturum sonundaki yakalama zaten kullandığın bir harness'ın CLI'ı üzerinden çalıştığı için API anahtarı istemez ve dışarıdaki hiçbir API'yi çağırmaz. Sıra önce oturumun harness'ındadır. Sonra bu hafta kullandığın diğer harness'lar gelir. Bir harness yalnızca 5 saatlik kullanımı %75'in, haftalık kullanımı %85'in altındayken seçilir. Model hata verirse, kullanım sınırına takılırsa ya da geçersiz yanıt döndürürse hiçbir şey yazılmaz.

## Gizlilik

- Anahtarlar, token'lar ve parolalar herhangi bir şey yazılmadan önce maskelenir.
- `<private>...</private>` içindeki metin hiçbir zaman saklanmaz.
- `memory.exclude` listesindeki projeler ne kaydedilir ne de hatırlanır. Liste mutlak ya da `~` ile başlayan yolları, glob'ları, yalın klasör adlarını veya `origin` remote'unun `owner/repo` adını kabul eder. Bu projelerde kişi hafızan yine geçerlidir.
- Bir harness'ın ortamında `BURACLE_NO_CAPTURE=1` varsa o harness'ın oturumları hiçbir şey kaydetmez.

```sh
buracle config set memory.exclude '[~/work/client-project]'
```

## Komut satırından hafıza

Altı hafıza aracının her birinin bir CLI karşılığı vardır. Böylece hem sen hem de her harness hafızaya terminalden ulaşabilir.

| MCP aracı | CLI karşılığı |
|---|---|
| `memory_search` | `buracle mem search "<query>"` |
| `memory_get` | `buracle mem get <id>` |
| `memory_write` | `buracle mem write --type <kind> --title "<claim>" --summary "<one line>"` |
| `memory_update` | `buracle mem update <id> --patch '<json>'` |
| `memory_status` | `buracle mem status` |
| `memory_context` | `buracle mem context` |

Diğerlerini `buracle mem --help` listeler: `remember`, `capture`, `backup`, `restore`, `doctor` ve `ui`.
