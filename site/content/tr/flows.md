---
title: Kullanım senaryoları
description: Hangi durumda hangi komutu kullanacağın, ilk istekten doğrulanmış sonuca altı oturum ve çalışmaları kısa tutan alışkanlıklar.
order: 3
---

Aşağıdaki her senaryo tek bir oturumdur: Ne yazdığını, ajanın her adımda ne yaptığını, hangi dosyaların ve dalların oluştuğunu adım adım görürsün. Her döngünün ayrıntısı [iş akışları](workflows.md) sayfasında.

Örneklerde skill'ler `/` ile başlar. Codex'te `$plan-build`, Pi'de `/skill:plan-build` yaz. İstekleri Türkçe de yazabilirsin. Planlar, PRD'ler ve raporlar senin dilinde yazılır.

## Hangi durumda hangi komut

| Durum | Komut | Ne elde edersin |
|---|---|---|
| Küçük ve net bir değişiklik | Komut gerekmez, doğrudan iste | Aynı korumalar ve aynı hafıza altında yapılmış değişiklik |
| Sorun ya da kapsam henüz net değil | `/requirements <idea>` | `docs/requirements/` içinde onaylı bir PRD ve sonraki adımın komutu |
| Birden çok modüle dokunan ve önce onaylamak istediğin bir değişiklik | `/plan-build <task>` | `docs/plan-build/` içinde incelenmiş bir plan, testle başlayan görevler, gerçek programda bir çalıştırma, son onayın ve `VERIFIED` |
| Varılacak noktayı geçti/kaldı ölçütleriyle yazabiliyorsun | `/goal-build <goal>` | `docs/goal-build/` içinde kilitli bir sözleşme, en çok dört yargılanan yapım turu ve doğrulanmış bir teslim |
| Tek bir davranış bozuk ve düzeldiğinin kanıtını istiyorsun | `/bugfix <symptom>` | `file:line` olarak kök neden, bu nedenle düşen bir test, düzeltme ve gerçek programda bir çalıştırma |
| Kodu değiştirmeden önce anlaman gerekiyor | `/inspect <question>` | `file:line` kanıtlı bir yanıt. Hiçbir şey değişmez |
| Dışarıdan bilgi, sürüm ya da karşılaştırma lazım | `/research <question>` | Her bulgunun kaynağını gösteren bir araştırma notu |
| Depoda ajan yönergesi yok | `/project-rules` | Ajanın çalıştırıp doğruladığı komutlarla yazılmış, her harness'a eşitlenen bir `AGENTS.md` |
| Kullanılmayan kod olduğundan şüpheleniyorsun | `/dead-code` | Sıralanmış bir rapor ve aşamalı bir kaldırma planı. Hiçbir şey silinmez |
| Bir kural bundan sonra hep geçerli olsun | "Bundan sonra …" de | Her harness'ın yüklediği bir tercih hafızası |
| Tekrarlanan bir iş için skill yok | `/find-skill <need>` ya da `/new-skill` | Denetlenip her harness için kurulan bir skill ya da yeni bir skill |
| Bir planı ya da farkı okuyup not bırakmak istiyorsun | `/brain review` | [Konsol'un inceleme sayfası](console.md#inceleme-sayfası) |

## Altı senaryo

### Kapsamı bulanık bir özellik

Rapor sayfasına kayıtlı arama gerektiğini biliyorsun ama aramaları kimin paylaşacağına ve neyin saklanacağına henüz karar vermedin. `/requirements` ile başla, onaylanan PRD'yi `/plan-build`'e ver.

```text
sen:    /requirements saved searches for the reports page
ajan:   Rapor kodunu semble ve codegraph ile, önceki kararları hafızadan okur.
ajan:   Bir araştırma düzeyi seçip gereken bilgileri doğrular (context7, web araması).
ajan:   Her turda birkaç soru sorar, ardından iki ya da üç yaklaşımı bir tabloda gösterir.
sen:    ikincisi
ajan:   Kapsamı netleştirir: R1-R6 gereksinimleri ve kapsam dışı kalanların listesi.
        + docs/requirements/2026-11-18-saved-searches.md
ajan:   PRD inceleme sayfasında (localhost:41777/review). Onaylıyor musun, değişiklik mi istiyorsun, duralım mı?
sen:    onaylıyorum
ajan:   Sıradaki adım, senin çalıştırman için:
        /plan-build Implement the approved PRD docs/requirements/2026-11-18-saved-searches.md
sen:    /plan-build Implement the approved PRD docs/requirements/2026-11-18-saved-searches.md --worktree
ajan:   Kodu inceler, planı yazar ve doğrular. plan-build-review planı denetler.
        + docs/plan-build/2026-11-18-saved-searches.md
ajan:   Hedefi, görevleri ve inceleme bulgularını gösterir. Bu planı onaylıyor musun?
sen:    onaylıyorum
ajan:   plan-build/saved-searches dalında .worktrees/saved-searches worktree'sini açar.
ajan:   Görev 1: RED, yeni test düşer. GREEN, test geçer. Her görev böyle ilerler.
ajan:   Doğrulama: changes-review, testler, tipler, lint, build, gerçek program, ardından SC-1 ve SC-2.
ajan:   Sonucu onaylıyor musun, değişiklik mi istiyorsun, yoksa önce kendin mi deneyeceksin?
sen:    onaylıyorum
ajan:   İşi squash merge ile main'e birleştirir, kontrolleri orada yeniden çalıştırır.
        Saved searches: VERIFIED
```

`/requirements` kod yazmaz ve sonraki iş akışını kendisi başlatmaz. Komutu yazdırır, sen çalıştırırsın.

### Kullanıcının gördüğü bir hata

Fatura toplamı son kalemi atlıyor. `/bugfix` bir şeyi değiştirmeden önce nedeni kanıtlar.

```text
sen:    /bugfix invoice total skips the last line item
ajan:   Nerede çalışayım? Bulunduğun dal, yeni bugfix/invoice-last-item dalı ya da bir worktree?
sen:    yeni dal
ajan:   bugfix/invoice-last-item dalına geçer.
ajan:   Araştırma: hatalı durumu çalıştırıp çıktının tamamını okur.
        Kök neden: src/billing/total.ts:27, sumItems döngüsü items.length - 1'de duruyor. Güven: yüksek.
ajan:   RED: kullanıcının eriştiği giriş noktasında yazılan bir test yanlış toplamla düşer.
ajan:   Düzeltme: döngü artık her indisi geziyor. RED testi ve modülün testleri geçer.
ajan:   Kanıt: ilk durumu gerçek programda yeniden çalıştırır. Toplam artık son kalemi içerir.
ajan:   Kalite kapısı: tüm test takımı, tipler, lint, build ve farkın üzerinde changes-review.
ajan:   "fix: include the last line item in invoice totals" mesajıyla commit edeyim mi?
sen:    commit et
ajan:   Rapor: kök neden, RED kanıtı, uçtan uca kontrol ve commit'iyle birlikte dal.
```

Basit bir "şunu düzelt" isteği iş akışı olmadan da çalışır. Kök nedenin ve kanıtın kayıt altına girmesini istediğinde `/bugfix` kullan.

### Ölçülebilir bir hedef

Arama yavaş ve ne zaman yeterince hızlı sayılacağını biliyorsun. `/goal-build` bunu ölçütlere çevirip her ölçüt geçene kadar yapım turlarını sürdürür.

```text
sen:    /goal-build search p95 under 200 ms on the seed data
ajan:   Hedefi bir son durum olarak yeniden yazar, arama kodunu ve hafızayı okur.
ajan:   Hedefe ulaşıldığını neyin kanıtlayacağını (oracle), her ölçütü hangi kanıtın karara bağlayacağını,
        sonuç bitmiş görünürken nasıl yanlış olabileceğini ve yapımın nerede çalışacağını sorar.
sen:    oracle seed verisindeki benchmark betiği olsun, worktree kullan
ajan:   Sözleşmeyi taslak olarak yazar: hedef, bir referans, C1-C4 ölçütleri ve görevler.
        + docs/goal-build/2026-11-18-search-p95.md
ajan:   goal-build-review her ölçütü denetler. Ajan bulguları düzeltip sözleşmeyi kilitler.
        Locked for this run: reviews.changes on, goalVerification on
ajan:   goal-build/search-p95 dalında .worktrees/search-p95 worktree'sini açar.
ajan:   Tur 1: açık görevlerin hepsini yapar, ardından her ölçütü çalışan programda yargılar.
        C1 pass · C2 pass · C3 fail · C4 pass
ajan:   Tur 2: geçemeyen ölçüt yeni görevlere dönüşür. Yeniden yargılanır, dördü de geçer.
ajan:   Doğrulama: changes-review, tüm kontroller ve inceleme sayfasındaki notların.
ajan:   İşi squash merge ile main'e birleştirir.
        Search p95: done · rounds 2/4 · VERIFIED
```

Bütün sorular kilitten önce sorulur. Kilitten sonra ajan seninle yalnızca işi teslim ederken ya da çözümü sende olan bir engel çıktığında konuşur.

### Yeni katıldığın bir kod tabanı

Depoyu bir kez hazırla, sonra bir şeyi değiştirmeden önce sorularını sor.

```text
sen:    buracle project sync        (terminalde, deponun içinde)
        AGENTS.md var mı diye bakar, .agents/skills klasörünü .claude/skills içine bağlar, projenin beynini kurar.
sen:    /project-rules
ajan:   Paket betiklerini, CI işlerini, lint ve test yapılandırmalarını, test düzenini okur.
ajan:   Her komutu yazmadan önce çalıştırır ya da "(not verified: <reason>)" diye işaretler.
        + AGENTS.md
        + .claude/rules/<slug>.md    (yalnızca kendi kuralları olması gereken dosya türleri için)
ajan:   buracle project sync ve buracle project check çalıştırır.
sen:    /inspect how does the token refresh work?
ajan:   Sınanacak tek bir iddia kurar, kodu semble ile bulur, çağıranları codegraph ile izler.
ajan:   Yolun her adımı için file:line kanıtı ve bir güven düzeyiyle yanıtlar. Hiçbir dosya değişmez.
```

### Bahar temizliği

Ölü kod denetimi yalnızca raporlar ve plan çıkarır. Kaldırma işi senin başlattığın ayrı bir çalışmadır.

```text
sen:    /dead-code
ajan:   Adayları projenin kendi analiz araçlarından, rg tabanlı bir betikten ve codegraph'tan toplar.
ajan:   Her adayı bağımsız sinyallerle sınar ve genel bir rolü olup olmadığına bakar
        (API, giriş noktası, yapılandırma, kayıt listesi).
ajan:   Rapor: karar başına sayılar, kanıtıyla her aday ve partilere bölünmüş bir kaldırma planı.
        git status denetimden önceki dosyaları gösterir.
sen:    kaydet
        + docs/dead-code/2026-11-18-src.md
sen:    /plan-build remove batch 1 from docs/dead-code/2026-11-18-src.md
ajan:   Parti için bir plan yazıp onayını ister, ardından görev görev kaldırıp kontrol eder.
```

### Görevin ortasında ajan değiştirmek

Hafıza projeye ve sana ait. Bu yüzden bir harness'a söylediğin kural ötekilere de ulaşır.

```text
Claude Code'da:
sen:    Bundan sonra bu depoda pnpm kullan.
ajan:   Bunu hemen, senin sözlerinle bir tercih hafızası olarak kaydeder.

Ertesi gün Codex'te:
sen:    $plan-build add CSV export to the reports page
ajan:   Oturum proje hafızasıyla açılır, pnpm tercihi de içindedir.
ajan:   Plandaki komutlar pnpm kullanır.
sen:    /brain
ajan:   buracle mem ui --open çalıştırır. Konsol bu hafızayı 4. bölgede, You & preferences altında gösterir.
```

## İyi uygulamalar

- Her depoda bir kez `buracle project sync` ve `/project-rules` çalıştır. Böylece her harness aynı `AGENTS.md` dosyasını izler.
- Bulanık işe `/requirements` ile başla, PRD'yi `/plan-build` ya da `/goal-build` iş akışına ver.
- Tek bozuk davranış için `/bugfix`, birden çok modüle dokunan iş için `/plan-build` kullan. Geçti/kaldı ölçütü yazabildiğinde `/goal-build` seç.
- Plan-build ve goal-build'in worktree'de çalışmasına izin ver. Dal yalıtımı açıkken önerilen seçenek budur ve checkout'un birleştirmeye kadar olduğu gibi kalır.
- Sonucu onaylamadan önce farkı inceleme sayfasında oku, notlarını oradaki satırlara iliştir. Ajan onay istemeden önce açık notların hepsini okur.
- Onay sorusunu açık bir "onaylıyorum" ile yanıtla. Tek başına "devam" bir planı ya da sonucu hiçbir zaman onaylamaz.
- "Bundan sonra …" diye bir kez söyle, bütün harness'lar uysun.
- Başka bir harness'tan ikinci görüş almak için `buracle config set plan.reviews.companion auto` çalıştır.
- Bilmediğin bir kodu değiştirmeden önce `/inspect` ile sor. Yalnızca okur, hiçbir şeyi değiştirmez.

## Nerede çalışılacağını seç

Dal yalıtımı açıkken (`plan.branchIsolation`, varsayılan) plan-build, goal-build ve bugfix işin nerede yapılacağını sorar. Bu soruyu önceden yanıtlamak için isteğin sonuna bir bayrak ekle. Çalışmanın dalı iş akışının adını taşır: `plan-build/<slug>`, `goal-build/<slug>` ya da `bugfix/<slug>`.

| Bayrak | Ajan ne yapar | Ne zaman seçilir |
|---|---|---|
| `--worktree` | Çalışmanın dalında `.worktrees/<slug>` klasörünü açar. İş sonunda squash merge ile temel dala birleştirilir | Checkout'una dokunulmasın istiyorsan ya da paralel başka işler yürütüyorsan |
| `--new-branch` | Checkout'unu o anki commit'ten başlayan çalışma dalına geçirir. Commit edilmemiş değişiklikler de birlikte gelir | İşin ikinci bir klasör açmadan kendi dalında durmasını istiyorsan |
| `--current-branch` | Üzerinde bulunduğun dalda çalışır | Değişiklik küçükse ve çalışma ağacın temizse |

`/plan-build add CSV export to the reports page --worktree` yalıtım sorusu sormadan başlar. Bugfix çalışmasında ajan riske göre önerir: Temiz bir ağaçta tek satırlık bir düzeltme için bulunduğun dalı, birkaç modüle dokunan bir düzeltme ya da kirli bir ağaç için worktree'yi.

Worktree'deki bir plan-build çalışması biterken ajan üç seçenek sunar: işi squash merge ile temel dala birleştirmek, incelemen için saklamak ya da atmak. Birleştirmeden sonra temel dalda testleri, tip denetimini, lint'i, build'i ve bir duman testini yeniden çalıştırır.

## Çalışmayı duraklat, sürdür ya da bırak

Kayıtlı bir plan-build ya da goal-build çalışması `VERIFIED` olana kadar [durdurma koruması](workflows.md#durdurma-koruması) ajanın turunu açık tutar. Çalışmayı şu mesajlarla yönetirsin:

| Gönderdiğin | Ne olur |
|---|---|
| "dur", "bekle" ("stop", "wait", "hold on") | Buracle Stack bir duraklama kaydeder. Ajan o anki adımı bitirir, oturumun arka planda başlattıklarını durdurur, nerede kaldığını söyleyip bekler |
| "devam" ("continue") ya da `/plan-build resume` | Çalışma planın kaldığı yerden sürer |
| "iptal", "vazgeç" ("cancel", "abandon", "drop it") | Ajan durur ve bir şeyi atmadan önce sana sorar. Plan dosyası yerinde kalır |

Buracle Stack bu sözcükleri yalnızca mesajın tamamı bunlardan oluştuğunda okur. "Sunucuyu durdur" sıradan bir istektir ve ajan onu anlamına göre uygular.

"Devam" açık bir soruyu yanıtlamaz. Plan onayı, sonuç incelemesi ya da ajanın sana sorduğu bir karar, sen yanıtlayana kadar açık kalır. Duraklatılmış bir goal-build çalışmasını `/goal-build` komutunu yeniden çağırarak da sürdürebilirsin. Bir `/bugfix` çalışmasının plan dosyası yoktur, bu yüzden durdurma koruması onu tutmaz: "dur" dediğinde ajan bulunduğu aşamayı, o ana kadarki kök nedeni ve değişen dosyaları raporlar.

## Başka bir ajandan ikinci görüş al

İkinci bir harness aynı planı, sözleşmeyi ya da farkı inceleyebilir. Bir ajan inceleme anahtarlarını değiştiremez, bu yüzden komutu kendin çalıştır:

```sh
buracle config set plan.reviews.companion auto
```

| Değer | İnceleyen |
|---|---|
| `off` | Yok (varsayılan) |
| `auto` | Kurulu başka bir harness. Modeli oturumdakinden farklı bir aileden gelen harness'ı tercih eder |
| `claude`, `codex`, `opencode`, `omp`, `qwen`, `pi`, `agy` | Adı verilen harness |

İkinci görüş arka planda ve salt okunur çalışır, her plan ve inceleme için bir kez yapılır. Plan incelemesini, goal-build sözleşme incelemesini, değişiklik incelemesini ve bugfix'in değişiklik incelemesini kapsar. Bulguları, inceleyicinin bulgularıyla aynı biçimde değerlendirilir ve aynı ağırlığı taşır. İkinci görüş alınamaz ya da başarısız olursa çalışma onsuz sürer, plan (`## Review Notes`) ya da bugfix raporu bunu belirtir. Bu anahtar Konsol'un [ayarlarında](console.md#ayarlar) da var.

## Onaydan sonra modeli değiştir

Planı bir modelle, uygulamayı başka bir modelle yapmak için:

```sh
buracle config set plan.modelSwitch manual
```

Bir plan-build planını onayladığında çalışma duraklar. Harness'ın model seçicisini aç (`/model`, OpenCode'da `/models` ya da ctrl+x m, Oh My Pi'de `/model` ya da `/switch`), uygulama için modeli seç ve "devam" de. Codex'te akıl yürütme düzeyini de seç. Oh My Pi ilk düzenlemede modeli kendisi değiştirebilir, bunun için `/prewalk` komutunu ya da `prewalk.enabled` ayarını kullan. Plan onayı kapalıysa çalışma duraklamaz ve o anki modelle sürer.
