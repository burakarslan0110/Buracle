---
title: İş akışları
description: Bir ajanla çalışmanın üç yolu, dört Buracle Stack iş akışı ve başlatabileceğin diğer komutlar.
order: 2
---

Harness'ını bir projede aç ve her zamanki gibi çalış. Aşağıdaki yolların hepsi aynı [korumalar](guards.md) ve aynı [hafıza](memory.md) ile çalışır.

- Doğrudan istek. Değişikliği iste, ajan bir iş akışı başlatmadan üzerinde çalışsın.
- Harness'ın yerleşik plan modu. Orada bir planı onayladığında Buracle Stack onu `docs/plan-build/` içine kaydeder. OpenCode'da onay adımı olmadığı için taslak kaydedilir. Ayrıntı için [harness'lara göre plan modu](harnesses.md#plan-modu) bölümüne bak.
- Bir Buracle Stack iş akışı. Yalnızca adını söyleyerek çağırdığında başlar.

## İş akışı başlatmak

İş akışının adını ve isteğini yaz, örneğin `/plan-build add CSV export to the reports page`. İsteği Türkçe de yazabilirsin. Codex skill'leri `$` ile (`$plan-build`), Pi ise `/skill:` ile (`/skill:plan-build`) başlatır. Diğer harness'lar `/` kullanır.

## Dört iş akışı

| İş akışı | Ne zaman | Ne elde edersin |
|---|---|---|
| `/plan-build` | Kod yazılmadan önce incelenmiş ve onaylanmış bir plan istiyorsan | `docs/plan-build/` içinde bir plan, her değişiklikten önce başarısız bir test, incelemeler, gerçek programın çalıştırılması ve senin onayın |
| `/goal-build` | Varılacak durum belli, yol ise yaparken bulunacaksa | `docs/goal-build/` içinde en az üç geçti/kaldı ölçütü olan kilitli bir sözleşme, çalışan kanıta göre değerlendirilen en çok dört yapım turu ve son doğrulama |
| `/bugfix` | Tek bir davranış bozuksa ve düzeldiğinin kanıtını istiyorsan | Yeniden üretilen hata, `file:line` olarak kök neden, başarısız bir test, düzeltme ve uçtan uca kontrol |
| `/requirements` | Problem ya da kapsam henüz belirsizse | Birkaç tur soru ve `docs/requirements/` içinde, plan-build ya da goal-build'e verilmeye hazır onaylı bir PRD |

`/plan-build` ayrıca `pause`, `resume` ya da var olan bir planın yolunu alır, örneğin `/plan-build docs/plan-build/2026-11-17-csv-export.md`.

Bu iş akışlarının nasıl çalışacağını [iş akışı anahtarları](console.md#ayarlar) belirler: hangi onayların isteneceğini, hangi incelemelerin yapılacağını, soru sorulup sorulmayacağını ve başka bir harness'ın ikinci görüş verip vermeyeceğini.

## Her iş akışı nasıl ilerler

Her iş akışı aşamalarından sırayla geçer ve bir kontrol başarısız olunca geri döner. Plan-build, goal-build ve bugfix davranışı değiştiren her işe başarısız bir testle başlar ve sonucu bağımsız bir incelemeye gönderir. Requirements ise hiç kod yazmaz. [Kullanım senaryoları](flows.md) sayfası her birini baştan sona bir oturum olarak gösterir.

### plan-build

Kod yazılmadan önce incelenmiş bir planı onaylamak istediğinde kullan. Senaryo: [kapsamı bulanık bir özellik](flows.md#kapsamı-bulanık-bir-özellik).

1. Plan. Ajan kodu inceler, her turda en çok üç soru sorar (en fazla iki tur) ve planı `docs/plan-build/` içine yazar.
2. Plan incelemesi. `buracle plan validate` biçimi denetler, plan-build-review ajanı da kapsamı, riskleri, görev sırasını ve testleri inceler.
3. Senin onayın. Planı onaylarsın ya da inceleme sayfasında plana not iliştirip değişiklik istersin.
4. Yapım. Her görev başarısız bir testle (RED) başlar, ardından o testi geçiren en küçük kod gelir (GREEN).
5. Doğrulama. changes-review, testler, tipler, lint ve build çalışır. Ardından gerçek program değişen her yüzeyde denenir, E2E senaryoları ve son bir regresyon testi çalıştırılır.
6. Son onayın. Sonucu onaylarsın, değişiklik istersin ya da önce kendin denersin. Worktree'deki iş onayından sonra birleştirilir.
7. `VERIFIED`. `buracle plan verify` kanıt bölümlerini denetleyip çalışmayı kapatır.

Bir kontrol başarısız olursa ajan plana düzeltme görevleri ekler ve Yapım aşamasına döner. Aynı eksik üç turdan sonra da sürüyorsa durup sana sorar.

### goal-build

Varılacak nokta belli, yol ise yaparken bulunacaksa kullan. Senaryo: [ölçülebilir bir hedef](flows.md#ölçülebilir-bir-hedef).

1. Hedef ve oracle. Ajan hedefi yeniden yazar ve hedefe ulaşıldığını kanıtlayacak tek sinyali, yani oracle'ı belirler. Bütün sorularını bu aşamada sorar.
2. Sözleşme. En az üç geçti/kaldı ölçütü ve görevler `docs/goal-build/` içine yazılır.
3. İnceleme ve kilit. goal-build-review ajanı her ölçütü denetler, ardından ajan sözleşmeyi kilitler. Kilitten sonra bir ölçüt yalnızca sen yeniden yazarsan ya da yazıldığı hâliyle yargılanamıyorsa değişir.
4. Yapım turu. Ajan açık görevlerin hepsini yapar.
5. Yargılama. Her ölçüt çalışan programdan gelen kanıtla geçti ya da kaldı diye karara bağlanır. Eksik kanıt kaldı sayılır, oracle en son yargılanır.
6. Doğrulama. changes-review ve tüm kontroller çalışır. `plan.goalVerification` bu aşamayı kapatabilir.
7. Teslim. Tek bir sonuçla biten bir rapor: done (`VERIFIED`), tur sınırı, engellendi ya da ulaşılamaz.

Geçemeyen ölçütler bir sonraki turun görevleri olur. Dört yargılama turundan sonra ajan, durum ne olursa olsun işi sana teslim eder.

### bugfix

Tek bir davranış bozuksa ve düzeldiğinin kanıtını istiyorsan kullan. Senaryo: [kullanıcının gördüğü bir hata](flows.md#kullanıcının-gördüğü-bir-hata).

1. Yeniden üret. Ajan hatalı durumu çalıştırıp çıktının tamamını okur.
2. Kök neden. Nedeni `file:line` olarak, kodun ne yaptığı ve ne yapması gerektiğiyle birlikte yazar.
3. RED. Senin kullandığın giriş noktasında yazılan bir test, bildirilen nedenle düşer.
4. Kaynağında düzelt. Değişiklik, hatalı durumu üreten koda yapılır.
5. Kanıtla. İlk durum gerçek programda yeniden çalıştırılır.
6. Kalite kapısı. Tüm test takımı, tipler, lint, build ve changes-review çalışır.
7. Bitir. Commit etmeyi, değişiklik istemeyi ya da açıklama almayı sen seçersin. Worktree'deki iş burada squash merge ile birleştirilir.

Test düzeltmeden önce geçiyorsa kök neden yanlıştır ve ajan araştırmaya döner. Test düzeltmeden sonra hâlâ düşüyorsa ajan düzenlemesini geri alıp yine araştırmaya döner. Değişiklik istediğinde de aynısı olur. Bugfix'in plan dosyası yoktur, bu yüzden durdurma koruması onu açık tutmaz.

### requirements

Sorun ya da kapsam henüz netleşmediyse kullan. Senaryo: [kapsamı bulanık bir özellik](flows.md#kapsamı-bulanık-bir-özellik).

1. Anla. Ajan fikri yeniden yazar ve onu koda ve hafızaya dayandırır.
2. Araştır. Ajan bir düzey seçer: atla, hızlı (birkaç bilgiyi kendisi doğrular), standart ya da derin (`/research` skill'iyle).
3. Fikir üret. Henüz bir çözüm söylemediysen düzyazıyla üç ila beş yön önerir.
4. Netleştir. Hedef kitle, temel akış, kısıtlar ve başarı sinyali üzerine sorular sorar.
5. Öner. Emeği ve riskleriyle iki ya da üç yaklaşımı bir tabloda gösterir. Birini sen seçersin.
6. Uzlaş. Ajan kapsama girenleri ve girmeyenleri belirler, R1-Rn gereksinimlerini her birine bir öncelik vererek yazar.
7. PRD ve onayın. PRD `docs/requirements/` içine yazılır ve notların için inceleme sayfasında açılır.
8. Devret. Ajan `/plan-build` ya da `/goal-build` komutunu yazdırır, sen çalıştırırsın.

Değişiklik istediğinde ajan PRD'yi yerinde düzenleyip onayını yeniden ister, üç turdan sonra da sürdürmek isteyip istemediğini sorar. Onaydan önce kod yazılmaz.

## İş nerede yapılır

Dal yalıtımı açıkken (`plan.branchIsolation`, varsayılan) plan-build, goal-build ve bugfix işin nerede yapılacağını sorar. İsteğin ardından eklediğin bir bayrak bu soruyu önceden yanıtlar:

| Bayrak | İşin yapıldığı yer |
|---|---|
| `--worktree` | Kendi dalı olan yeni bir worktree |
| `--new-branch` | Checkout'unda yeni bir dal |
| `--current-branch` | Üzerinde bulunduğun dal |

Worktree'deki iş doğrulandığında plan-build üç seçenek sunar: işi squash merge ile temel dala birleştirmek, incelemen için saklamak ya da atmak. Goal-build işi yapım doğrulanınca, bugfix ise düzeltme kanıtlanınca squash merge ile birleştirir. Hangi bayrağı ne zaman seçeceğin [Nerede çalışılacağını seç](flows.md#nerede-çalışılacağını-seç) bölümünde.

## Durdurma koruması

Kayıtlı bir plan `VERIFIED` olana kadar durdurma koruması ajanın turunu açık tutar. Böylece onaylanmış bir çalışma yarıda kalmaz. Ajan sana gerçek bir soru sormadan ya da işi sana devretmeden önce `buracle plan pause` ile bir duraklama kaydeder.

Çalışmayı kendin duraklatmak için yalnızca "dur", "bekle", "stop", "wait" ya da "hold on" yazan bir mesaj gönder. Buracle Stack bu sözcükleri Türkçe ve İngilizce tanır. Devam etmek için "devam" de ya da `/plan-build resume` çalıştır. Bütün kontrol sözcükleri [Çalışmayı duraklat, sürdür ya da bırak](flows.md#çalışmayı-duraklat-sürdür-ya-da-bırak) bölümünde. Durdurma korumasını `buracle config set plan.stopGuard false` ile kapatabilirsin. Bir ajan bu ayarı değiştiremez.

## Diff'i planla karşılaştırmak

`buracle plan audit`, planda listelenen dosyaları diff ile karşılaştırıp eksik kalan planlı işleri ve hiçbir görevin planlamadığı değişiklikleri raporlar. Bulgu varsa 2 koduyla çıkar.

## Diğer komutlar

| Komut | Ne yapar |
|---|---|
| `/research <question>` | Kaynak göstererek araştırır: web araması, sayfaların tamamını okuma, kütüphane belgeleri, açık kaynak kod ve hafıza |
| `/inspect <question>` | Tek bir soruyu çalışan kodda izler ve `file:line` kanıtıyla yanıtlar. Hiçbir şeyi değiştirmez |
| `/dead-code` | Kullanılmayan dosyaları ve export'ları bulur, her birini bağımsız sinyallerle sınar ve aşamalı bir kaldırma planı çıkarır. Hiçbir şeyi silmez |
| `/project-rules` | Çalıştırdığı komutlara dayanarak `AGENTS.md` ile yol kurallarını yazar ya da yeniler, ardından `buracle project sync` ve `buracle project check` çalıştırır |
| `/new-skill` | Tekrar ettiğin bir prosedürü skill'e çevirir ya da var olan bir skill'i iyileştirir |
| `/find-skill <need>` | Bir ihtiyaca uygun skill bulur, denetledikten sonra her harness için kurar |
| `/ab-test` | Bir skill ya da kural değişikliğinin ajanın davranışını değiştirip değiştirmediğini, geçici yapılandırma klasörlerinde eşli çalıştırmalarla ölçer |
| `/brain` | [Buracle Stack Konsolunu](console.md) açar, `/brain review` ise inceleme sayfasını açar |
| `/remember <text>` | Metni hafızaya bir yakalama olarak kaydeder |
| `/aside <question>` | Oturuma dokunmadan bir yan soru sorar |
| `/buracle-status` | Plan, iş akışı ve hafıza durumunu gösterir |

Son dört komut her harness'ta yerleşik komut olarak bulunmaz. Ayrıntı için [harness'lara göre komutlar](harnesses.md#komutlar) bölümüne bak.

## Kurallar ve senin dilin

Her oturumda toplamı 8 KB'ın altında kalan dört kısa kural yüklenir ve `buracle rules lint` bu sınırı denetler. Uzun yönergeler skill referanslarındadır. Ajan onları gerektiğinde okur.

Planlar, PRD'ler ve raporlar senin dilini izler. Yalnızca Buracle Stack'in okuduğu `VERIFIED` gibi işaretler İngilizce kalır.
