/**
 * loc.js — the single localization file. Every player-visible string lives
 * here, in Azerbaijani (az) and English (en). Switching language is a data
 * change: t() reads the current language on every call.
 *
 * Placeholders use {name}; t('key', { name: 'Əli' }) substitutes them.
 * Pure module (no imports) so tests can load it under Node.
 */

const az = {
  // ── front end
  title: 'ŞUŞA: DUMANLI YOL', subtitle: 'Noyabr 2020', tagline: 'Duman bizim tərəfimizdədir.',
  pressKey: 'Davam etmək üçün klikləyin və ya istənilən düyməni basın',
  newGame: 'Yeni oyun', continue: 'Davam et', settings: 'Ayarlar', controls: 'İdarəetmə',
  credits: 'Müəlliflər', back: 'Geri', confirm: 'Təsdiqlə', cancel: 'Ləğv et', quit: 'Əsas menyuya çıx',
  resume: 'Davam et', restartCp: 'Son yoxlama nöqtəsindən başla', loading: 'Yüklənir…',
  lang: 'Dil', langName: 'Azərbaycanca', on: 'Açıq', off: 'Bağlı',
  continueInfo: '{name} · {act} · {diff}',
  nameTitle: 'Əsgərinizin adını daxil edin', namePlaceholder: 'Ad', nameHint: '2–20 simvol. Azərbaycan hərfləri dəstəklənir.',
  nameError: 'Ad 2–20 simvoldan ibarət olmalıdır.',
  diffTitle: 'Çətinlik səviyyəsi',
  diff_easy: 'Asan', diff_normal: 'Orta', diff_hard: 'Çətin',
  diff_easy_d: 'Düşmən gec görür və zəif vurur. Bütün HUD köməkləri açıqdır, sağlamlıq qismən bərpa olunur.',
  diff_normal_d: 'Balanslı döyüş. Yalnız aşkarlanma oxları göstərilir, sağlamlıq bərpa olunmur.',
  diff_hard_d: 'Düşmən iti, dəqiq və inadkardır. HUD köməyi yoxdur, sursat azdır, yoxlama nöqtələri seyrəkdir.',
  briefTitle: 'TAPŞIRIQ BRİFİNQİ', briefOperative: 'Əməliyyatçı', briefObjectives: 'Hədəflər', briefStart: 'Əməliyyata başla',
  brief_o1: 'Dumanlı meşədən səssiz keç və qayanın dibinə çat', brief_o2: 'Sıldırım qayaya dırmaş, patrula görünmə',
  brief_o3: 'Şuşanın küçələrini sektor-sektor təmizlə', brief_o4: 'Şəhər mərkəzini ələ keçir və bayrağı qaldır',
  brief_r1: 'Komandir: {name}, diqqətlə qulaq as. Şəhər boşaldılıb, küçələrdə yalnız silahlı düşmən əsgərləri var.',
  brief_r2: 'Komandir: Meşədən keçib qayaya dırmaşacaqsan. Yüngül silah, səsboğucu, bıçaq. Ağır texnika yoxdur.',
  brief_r3: 'Komandir: Tarixi və dini abidələrə toxunma. Onlar bizim yaddaşımızdır.',
  brief_r4: 'Komandir: Dan yeri söküləndə bayraq Şuşada dalğalanmalıdır. Uğurlar, {name}.',
  act1: 'I hissə — Meşə yolu', act2: 'II hissə — Qayalar', act3: 'III hissə — Şuşa küçələri', act4: 'IV hissə — Son həmlə',
  act1_d: 'Gecə. Şuşanın altındakı meşəli dərə. Qatı duman.', act2_d: 'Cıdır düzünün altındakı sıldırım qayalar.',
  act3_d: 'Sübh qabağı. Daş evlər, dar dalanlar, damlar.', act4_d: 'Dan yeri sökülür. Şəhər mərkəzi.',
  tip1: 'Əyilərək gəzmək həm səsini, həm də görünmə ehtimalını azaldır.', tip2: 'Kölgədə və kolluqda düşmən səni daha gec görür.',
  tip3: 'Səsboğucu köhnəldikcə səs artır. Sıfıra düşəndə qırılır.', tip4: 'Gizlədilməmiş cəsəd tapılsa, bütün sektor axtarışa başlayır.',
  tip5: 'Snayper tüfənginin səsi çox uzağa gedir. Atəşdən sonra mövqeyini dəyiş.', tip6: 'Daş atmaqla gözətçini postundan uzaqlaşdıra bilərsən.',
  tip7: 'Tüstü qumbarası düşmənin görüşünü kəsir: küçəni keçmək üçün istifadə et.', tip8: 'Rabitəçini vursan, növbəti məruzə vaxtına qədər tələs.',
  // ── objectives
  obj_a1: 'Qayanın dibindəki dırmaşma nöqtəsinə çat', obj_a1_opt: 'Əlavə: düşmən postundan snayper tüfəngini götür',
  obj_a2: 'Qayaya dırmaş. Patrul keçəndə tərpənmə', obj_a3: '«{sector}» sektorunu təmizlə',
  obj_a3_opt: 'Əlavə: rabitə qovşağını C4 ilə partlat', obj_a3_next: 'Növbəti sektora keç', obj_a4: 'Şəhər mərkəzini ələ keçir',
  obj_a4_flag: 'Bayrağı qaldır', remaining: 'Qalan düşmən: {n}',
  // vehicles and artillery
  obj_a3_tank: 'Əlavə: tankı məhv et — C4-ü mühərrik bölməsinə qoy', obj_a3_both: 'Əlavə: rabitə qovşağını və tankı C4 ilə partlat',
  obj_a1_bat: 'Əlavə: artilleriya batareyasını C4 ilə məhv et', obj_a1_both: 'Əlavə: snayper tüfəngini götür, batareyanı məhv et',
  obj_a4_tank: 'Əlavə: tankı məhv et və ya ondan yan keç',
  p_c4deck: '[{key}] C4-ü mühərrik bölməsinin üstünə qoy', p_c4rear: '[{key}] C4-ü arxa zirehə qoy', p_c4track: '[{key}] C4 qoy — burada yalnız tırtılı qırar',
  p_c4gun: '[{key}] C4-ü topa qoy', p_c4apc: '[{key}] C4-ü zirehli maşına qoy',
  tankNotice: 'Tankın qülləsi sənə tərəf dönür', tankAim: 'Tank əsas topu tuşlayır — yerini dəyiş!',
  tankTrack: 'Tırtıl qırıldı: tank yerindən tərpənə bilmir, amma atəş açır', tankDown: 'Tank məhv edildi',
  apcDown: 'Zirehli maşın məhv edildi', gunDown: 'Top məhv edildi', batteryDown: 'Artilleriya batareyası susduruldu',
  sec1: 'Aşağı məhəllə', sec2: 'Bazar meydanı', sec3: 'Qala yolu', sec4: 'Mərkəzi meydan',
  // ── HUD
  bleeding: 'QANAXMA', bleedingHeavy: 'AĞIR QANAXMA', armor: 'Zireh',
  st_stand: 'AYAQDA', st_crouch: 'ƏYİLMİŞ', st_prone: 'UZANMIŞ',
  mode_auto: 'AVTO', mode_semi: 'TƏK', suppressor: 'Səsboğucu', noiseLbl: 'SƏS',
  supOn: 'Səsboğucu taxıldı', supOff: 'Səsboğucu çıxarıldı', supBroke: 'Səsboğucu sıradan çıxdı!', supNone: 'Ehtiyat səsboğucu yoxdur',
  supNA: 'Bu silaha səsboğucu taxılmır', reloading: 'Doldurulur…', noAmmo: 'Patron yoxdur',
  p_takedown: '[{key}] Səssiz zərərsizləşdir', p_drag: '[{key}] Cəsədi sürü', p_drop: '[{key}] Cəsədi burax',
  p_dump: '[{key}] Cəsədi konteynerə gizlət', p_pickup: '[{key}] Götür: {item}', p_swap: '[{key}] Silahı dəyiş: {item}',
  p_ladder: '[{key}] Nərdivana çıx', p_ladderOff: '[{key}] Nərdivanı burax', p_climb: '[{key}] Dırmaşmağa başla',
  p_flag: '[{key}] basıb saxla — bayrağı qaldır', p_c4: '[{key}] C4 qoy', p_c4det: '[{key}] basıb saxla — C4 partlat',
  p_holdBreath: '[{key}] Nəfəsini saxla', p_next: '[{key}] Növbəti hissəyə keç',
  p_doorOpen: '[{key}] Qapını aç', p_doorClose: '[{key}] Qapını ört',
  bodyHidden: 'Cəsəd gizlədildi', checkpoint: 'Yoxlama nöqtəsi yadda saxlanıldı', spotted: 'AŞKARLANDIN', hiddenAgain: 'İZ İTDİ',
  alarm: 'Düşmən həyəcan qaldırdı!', bodyFound: 'Düşmən cəsəd tapdı!', checkinMissed: 'Rabitəçi məruzə etmədi: sektor ayıqdır',
  reinforce: 'Düşmənə kömək gəlir: {dir}', sectorClear: 'Sektor təmizləndi', areaSecure: 'Meydan nəzarətdədir',
  dirN: 'şimaldan', dirS: 'cənubdan', dirE: 'şərqdən', dirW: 'qərbdən',
  kf_kill: 'Zərərsizləşdirildi', kf_head: 'Başdan vuruş', kf_stealth: 'Səssiz', kf_knife: 'Bıçaqla', kf_blast: 'Partlayışla', kf_long: '{m} m',
  w_pistol: 'Tapança', w_akm: 'AKM', w_ak74: 'AK-74', w_svd: 'SVD', w_knife: 'Bıçaq',
  i_frag: 'Qumbara', i_smoke: 'Tüstü qumbarası', i_flash: 'İşıq-səs qumbarası', i_stone: 'Daş', i_tknife: 'Atma bıçaq',
  i_c4: 'C4', i_medkit: 'Tibbi çanta', i_bandage: 'Sarğı', i_tourniquet: 'Turniket', i_plate: 'Zireh lövhəsi',
  i_repair: 'Təmir dəsti', i_binoculars: 'Binokl', i_nvg: 'Gecəgörmə', i_suppressor: 'Ehtiyat səsboğucu', i_ammo: 'Patron',
  bn_range: 'MƏSAFƏ', bn_bearing: 'AZİMUT', bn_zoom: 'BÖYÜTMƏ', bn_tagging: 'nişanlanır', bn_hint: 'Təkər — böyütmə  ·  Düşməni mərkəzdə saxla — nişanla', bn_hintNoTag: 'Təkər — böyütmə',
  i_akmsup: 'AKM səsboğucusu', i_svdsup: 'SVD səsboğucusu', i_battery: 'Batareya', i_mag: 'Boş daraq',
  use_medkit: 'Tibbi çanta istifadə olunur…', use_bandage: 'Sarğı bağlanır…', use_tourniquet: 'Turniket sıxılır…',
  use_plate: 'Zireh lövhəsi dəyişdirilir…', use_repair: 'Səsboğucu təmir olunur…',
  no_item: 'Yoxdur: {item}', hpFull: 'Sağlamlıq doludur', noBleed: 'Qanaxma yoxdur', armorFull: 'Zireh bütövdür',
  nvgDead: 'Gecəgörmənin batareyası bitib', tagNA: 'Bu çətinlikdə nişanlama yoxdur', tagged: 'Düşmən nişanlandı',
  c4Placed: 'C4 quraşdırıldı', c4None: 'C4 yoxdur', relayDown: 'Rabitə qovşağı məhv edildi: kömək gəlməyəcək',
  picked: 'Götürüldü: {item}', swapHint: 'İki əsas silah daşıyırsan', full: 'Yer yoxdur: {item}',
  // ── climbing
  climbHint: '[W] yuxarı · [S] aşağı · Patrul baxanda TƏRPƏNMƏ', grip: 'TUTUŞ', climbFreeze: 'TƏRPƏNMƏ!', climbGo: 'DIRMAŞ',
  climbSlip: 'Əlin sürüşdü!', climbTop: '[{key}] Yuxarı çıx',
  // ── screens
  paused: 'FASİLƏ', clickResume: 'Davam etmək üçün klikləyin', failTitle: 'TAPŞIRIQ UĞURSUZ OLDU', failSub: '{name} sıradan çıxdı.',
  endTitle: 'TAPŞIRIQ YERİNƏ YETİRİLDİ', endSub: 'Şuşa azaddır.', e_soldier: 'Əsgər', e_diff: 'Çətinlik', e_time: 'Vaxt',
  e_kills: 'Zərərsizləşdirilən düşmən', e_heads: 'Başdan vuruş', e_stealth: 'Səssiz zərərsizləşdirmə', e_vehicles: 'Məhv edilən texnika', e_spotted: 'Aşkarlanma sayı',
  e_acc: 'Dəqiqlik', e_score: 'Xal', e_rank: 'Dərəcə', e_best: 'Ən yaxşı nəticə', e_newBest: 'Yeni rekord!', mainMenu: 'Əsas menyu',
  playAgain: 'Yenidən oyna', medal_S: '«Şuşanın azad olunmasına görə» medalı', medal_A: '«İgidliyə görə» medalı',
  medal_B: '«Hərbi xidmətlərə görə» medalı', medal_C: '«Döyüşdə fərqlənməyə görə» medalı',
  mapTitle: 'XƏRİTƏ', mapYou: 'Sən', mapObj: 'Hədəf', mapEnemy: 'Düşmən',
  // ── settings
  s_sens: 'Siçan həssaslığı', s_fov: 'Görüş bucağı (FOV)', s_invert: 'Y oxunu çevir', s_master: 'Ümumi səs', s_music: 'Musiqi',
  s_sfx: 'Səs effektləri', s_quality: 'Qrafika keyfiyyəti', q_low: 'Aşağı', q_medium: 'Orta', q_high: 'Yüksək',
  s_blur: 'Hərəkət bulanıqlığı', s_killcam: 'Kill-kamera', s_subs: 'Subtitrlər', s_binds: 'Düymə təyinatı',
  s_reset: 'Standarta qaytar', pressNew: 'Yeni düyməni basın…', s_game: 'Oyun', s_audio: 'Səs', s_video: 'Görüntü',
  a_forward: 'İrəli', a_back: 'Geri', a_left: 'Sola', a_right: 'Sağa', a_jump: 'Tullan / aş', a_sprint: 'Qaç / nəfəs saxla',
  a_crouch: 'Əyil', a_prone: 'Uzan', a_leanL: 'Sola əyil', a_leanR: 'Sağa əyil', a_fire: 'Atəş', a_aim: 'Nişan al',
  a_reload: 'Doldur', a_weapon1: 'Tapança', a_weapon2: 'Əsas silah 1', a_weapon3: 'Əsas silah 2',
  a_suppressor: 'Səsboğucu tax / çıxar', a_fireMode: 'Atəş rejimi', a_interact: 'Əlaqə / zərərsizləşdir / sürü',
  a_melee: 'Bıçaq zərbəsi', a_throw: 'Seçilmiş əşyanı at', a_cycleThrow: 'Atılan əşyanı dəyiş', a_c4: 'C4 qoy / partlat',
  a_medkit: 'Tibbi çanta', a_bandage: 'Sarğı', a_nvg: 'Gecəgörmə', a_wheel: 'Təchizat çarxı', a_map: 'Xəritə', a_pause: 'Fasilə',
  creditsText: 'Dizayn və proqramlaşdırma: Claude (Anthropic) ilə birgə.\nMühərrik: Three.js (MIT lisenziyası).\nPlatforma: Higgsfield.\nModellər, teksturalar və səslər prosedur üsulla yaradılıb; əlavə aktivlər design/assets.csv faylında göstərilib.\n\nBu oyun 2020-ci ilin noyabrında Şuşa uğrunda döyüşdən ilhamlanmış bədii əsərdir. Oyunda mülki şəxslər yoxdur; şəhər boşaldılmış kimi təqdim olunur.',
  // ── radio
  r_start: 'Komandir: {name}, eşidirsən? Duman bizim tərəfimizdədir. Səssiz irəlilə.',
  r_crouch: 'Komandir: Əyil və kölgədə qal. Ayaqda qaçsan, səni eşidəcəklər.',
  r_sentry: 'Komandir: Qabaqda tək gözətçi var. Arxadan yaxınlaş, bıçaqla zərərsizləşdir.',
  r_body: 'Komandir: Cəsədi kolluqda gizlət. Tapsalar, bütün sektor ayağa qalxacaq.',
  r_stone: 'Komandir: Daş at, diqqətlərini yayındır.',
  r_radio: 'Komandir: Rabitəçi tez-tez məruzə edir. Onu vursan, tez tərpən.',
  r_suppressor: 'Komandir: Səsboğucu əbədi deyil. Hər gülləni say.',
  r_svd: 'Komandir: Snayper tüfəngi tapdın. Unutma, səsi dağları oyadar.',
  r_cliff: 'Komandir: {name}, qayanın dibindəsən. Ləvazimatını hazırla. Yuxarıda Şuşa gözləyir.',
  r_climbHold: 'Komandir: Yuxarıda patrul! Tərpənmə.', r_climbGo: 'Komandir: Keçdilər. Qalx.',
  r_city: 'Komandir: {name}, şəhərin kənarındasan. Küçələri sektor-sektor təmizlə.',
  r_c4: 'Komandir: Rabitə qovşağını C4 ilə partlatsan, köməkləri kəsilər.',
  r_sectorClear: 'Komandir: Sektor təmizdir. Əla iş, {name}. Növbəti sektora keç.',
  r_reinforce: 'Komandir: Diqqət, düşmənə kömək gəlir!', r_spotted: 'Komandir: Səni gördülər! Mövqeyini dəyiş!',
  r_lost: 'Komandir: İzini itirdilər. Kölgəyə qayıt.', r_checkin: 'Komandir: Rabitəçi cavab vermir, düşmən şübhələndi.',
  r_final: 'Komandir: {name}, irəli! Şəhərin mərkəzi qarşındadır. Dan yeri sökülür.',
  r_flag: 'Komandir: Meydan bizimdir. Bayrağı qaldır, {name}!', r_end: 'Komandir: Şuşa azaddır. Vətən sənə minnətdardır, {name}.',
  r_lowhp: 'Komandir: Yaralısan! Sığınacaq tap və yaranı sarı.',
  r_tank: 'Komandir: Mühərrik səsini eşidirsən? Bazar meydanında tank var. Önünə çıxma. Arxadan yaxınlaş, C4-ü mühərrik bölməsinə qoy.',
  r_tank4: 'Komandir: Bayrağın önündə tank dayanıb. Onu partlat, ya da gözə görünmədən yanından keç.',
  r_battery: 'Komandir: Postdan düşmən topları atəş açır. Hər topun yanına bir C4 qoy. Sursat qutularının yanında C4 var.',
  r_tankTrack: 'Komandir: Tırtılı qırdın, tank yerində qaldı. Amma hələ atəş aça bilir. Mühərrik bölməsini vur!',
  r_tankDown: 'Komandir: Tank yanır! Əla iş, {name}.', r_batteryDown: 'Komandir: Toplar susdu. Bizimkilər sənə minnətdardır.',
  q_auto: 'Avto',
};

const en = {
  title: 'ŞUŞA: DUMANLI YOL', subtitle: 'The Foggy Path · November 2020', tagline: 'The fog is on our side.',
  pressKey: 'Click or press any key to continue',
  newGame: 'New Game', continue: 'Continue', settings: 'Settings', controls: 'Controls',
  credits: 'Credits', back: 'Back', confirm: 'Confirm', cancel: 'Cancel', quit: 'Quit to main menu',
  resume: 'Resume', restartCp: 'Restart checkpoint', loading: 'Loading…',
  lang: 'Language', langName: 'English', on: 'On', off: 'Off',
  continueInfo: '{name} · {act} · {diff}',
  nameTitle: "Enter your soldier's name", namePlaceholder: 'Name', nameHint: '2–20 characters. Azerbaijani letters are supported.',
  nameError: 'The name must be 2–20 characters long.',
  diffTitle: 'Difficulty',
  diff_easy: 'Easy', diff_normal: 'Normal', diff_hard: 'Hard',
  diff_easy_d: 'Enemies notice you late and hit softly. All HUD aids are on and health partly regenerates.',
  diff_normal_d: 'Balanced combat. Only detection arrows are shown and health does not regenerate.',
  diff_hard_d: 'Enemies are sharp, accurate and persistent. No HUD aids, scarce ammo, few checkpoints.',
  briefTitle: 'MISSION BRIEFING', briefOperative: 'Operative', briefObjectives: 'Objectives', briefStart: 'Begin operation',
  brief_o1: 'Cross the fog-bound forest unseen and reach the foot of the cliff', brief_o2: 'Climb the sheer rock without alerting the patrols',
  brief_o3: 'Clear the streets of Shusha one sector at a time', brief_o4: 'Secure the city centre and raise the flag',
  brief_r1: 'Commander: {name}, listen carefully. The city has been evacuated; only armed enemy soldiers hold the streets.',
  brief_r2: 'Commander: You go through the forest and up the cliff. Light weapons, a suppressor, a knife. No heavy armour.',
  brief_r3: 'Commander: Leave the historic and religious monuments untouched. They are our memory.',
  brief_r4: 'Commander: When dawn breaks the flag must fly over Shusha. Good luck, {name}.',
  act1: 'Act 1 — The Forest Approach', act2: 'Act 2 — The Cliffs', act3: 'Act 3 — The Streets of Shusha', act4: 'Act 4 — The Final Push',
  act1_d: 'Night. The forested valley below Shusha. Heavy fog.', act2_d: 'The sheer cliffs below Cıdır düzü.',
  act3_d: 'Before dawn. Stone houses, narrow lanes, rooftops.', act4_d: 'Dawn is breaking. The city centre.',
  tip1: 'Crouch-walking cuts both your noise and your chance of being seen.', tip2: 'Enemies notice you later in shadow and in bushes.',
  tip3: 'A suppressor gets louder as it wears. At zero it breaks.', tip4: 'If an unhidden body is found, the whole sector starts searching.',
  tip5: "The marksman rifle's report carries a long way. Relocate after firing.", tip6: 'A thrown stone can pull a sentry off his post.',
  tip7: 'Smoke blocks enemy vision: use it to cross a street.', tip8: 'Drop the radio operator and you are racing his next check-in.',
  obj_a1: 'Reach the climbing point at the foot of the cliff', obj_a1_opt: 'Optional: take the marksman rifle from the enemy outpost',
  obj_a2: 'Climb the cliff. Hold still while a patrol is watching', obj_a3: 'Clear the "{sector}" sector',
  obj_a3_opt: 'Optional: destroy the comms relay with C4', obj_a3_next: 'Move to the next sector', obj_a4: 'Secure the city centre',
  obj_a4_flag: 'Raise the flag', remaining: 'Enemies remaining: {n}',
  // vehicles and artillery
  obj_a3_tank: 'Optional: destroy the tank: C4 on the engine deck', obj_a3_both: 'Optional: blow the comms relay and the tank with C4',
  obj_a1_bat: 'Optional: destroy the artillery battery with C4', obj_a1_both: 'Optional: take the marksman rifle, destroy the battery',
  obj_a4_tank: 'Optional: destroy the tank or slip past it',
  p_c4deck: '[{key}] Place C4 on the engine deck', p_c4rear: '[{key}] Place C4 on the rear plate', p_c4track: '[{key}] Place C4 (here it only breaks a track)',
  p_c4gun: '[{key}] Place C4 on the gun', p_c4apc: '[{key}] Place C4 on the armoured vehicle',
  tankNotice: 'The tank\'s turret is turning your way', tankAim: 'The tank is laying its main gun on you: move!',
  tankTrack: 'Track broken: the tank cannot move, but it can still fire', tankDown: 'Tank destroyed',
  apcDown: 'Armoured vehicle destroyed', gunDown: 'Gun destroyed', batteryDown: 'Artillery battery silenced',
  sec1: 'Lower Quarter', sec2: 'Market Square', sec3: 'Fortress Road', sec4: 'Central Square',
  bleeding: 'BLEEDING', bleedingHeavy: 'HEAVY BLEEDING', armor: 'Armor',
  st_stand: 'STANDING', st_crouch: 'CROUCHED', st_prone: 'PRONE',
  mode_auto: 'AUTO', mode_semi: 'SEMI', suppressor: 'Suppressor', noiseLbl: 'NOISE',
  supOn: 'Suppressor attached', supOff: 'Suppressor detached', supBroke: 'Suppressor broke!', supNone: 'No spare suppressor',
  supNA: 'This weapon takes no suppressor', reloading: 'Reloading…', noAmmo: 'Out of ammo',
  p_takedown: '[{key}] Silent takedown', p_drag: '[{key}] Drag body', p_drop: '[{key}] Drop body',
  p_dump: '[{key}] Hide body in dumpster', p_pickup: '[{key}] Take: {item}', p_swap: '[{key}] Swap weapon: {item}',
  p_ladder: '[{key}] Climb ladder', p_ladderOff: '[{key}] Let go of ladder', p_climb: '[{key}] Start climbing',
  p_flag: 'Hold [{key}] — raise the flag', p_c4: '[{key}] Place C4', p_c4det: 'Hold [{key}] — detonate C4',
  p_holdBreath: '[{key}] Hold breath', p_next: '[{key}] Continue to the next act',
  p_doorOpen: '[{key}] Open the door', p_doorClose: '[{key}] Close the door',
  bodyHidden: 'Body hidden', checkpoint: 'Checkpoint saved', spotted: 'SPOTTED', hiddenAgain: 'TRAIL LOST',
  alarm: 'The enemy raised the alarm!', bodyFound: 'The enemy found a body!', checkinMissed: 'Radio check-in missed: sector on alert',
  reinforce: 'Enemy reinforcements from the {dir}', sectorClear: 'Sector cleared', areaSecure: 'Area secured',
  dirN: 'north', dirS: 'south', dirE: 'east', dirW: 'west',
  kf_kill: 'Neutralised', kf_head: 'Headshot', kf_stealth: 'Silent', kf_knife: 'Knife', kf_blast: 'Explosion', kf_long: '{m} m',
  w_pistol: 'Pistol', w_akm: 'AKM', w_ak74: 'AK-74', w_svd: 'SVD', w_knife: 'Knife',
  i_frag: 'Frag grenade', i_smoke: 'Smoke grenade', i_flash: 'Flashbang', i_stone: 'Stone', i_tknife: 'Throwing knife',
  i_c4: 'C4', i_medkit: 'Medkit', i_bandage: 'Bandage', i_tourniquet: 'Tourniquet', i_plate: 'Armor plate',
  i_repair: 'Repair kit', i_binoculars: 'Binoculars', i_nvg: 'Night vision', i_suppressor: 'Spare suppressor', i_ammo: 'Ammo',
  bn_range: 'RANGE', bn_bearing: 'BEARING', bn_zoom: 'ZOOM', bn_tagging: 'tagging', bn_hint: 'Wheel — zoom  ·  Hold a soldier in the centre to tag', bn_hintNoTag: 'Wheel — zoom',
  i_akmsup: 'AKM suppressor', i_svdsup: 'SVD suppressor', i_battery: 'Battery', i_mag: 'Empty magazine',
  use_medkit: 'Using medkit…', use_bandage: 'Applying bandage…', use_tourniquet: 'Tightening tourniquet…',
  use_plate: 'Replacing armor plate…', use_repair: 'Repairing suppressor…',
  no_item: 'None left: {item}', hpFull: 'Health is full', noBleed: 'Not bleeding', armorFull: 'Armor is intact',
  nvgDead: 'Night-vision battery is dead', tagNA: 'Tagging is off at this difficulty', tagged: 'Enemy tagged',
  c4Placed: 'C4 placed', c4None: 'No C4', relayDown: 'Comms relay destroyed: no more reinforcements',
  picked: 'Picked up: {item}', swapHint: 'You are carrying two primaries', full: 'Cannot carry more: {item}',
  climbHint: '[W] up · [S] down · HOLD STILL while a patrol is watching', grip: 'GRIP', climbFreeze: 'HOLD STILL!', climbGo: 'CLIMB',
  climbSlip: 'Your grip slipped!', climbTop: '[{key}] Pull up',
  paused: 'PAUSED', clickResume: 'Click to resume', failTitle: 'MISSION FAILED', failSub: '{name} is out of action.',
  endTitle: 'MISSION ACCOMPLISHED', endSub: 'Shusha is free.', e_soldier: 'Soldier', e_diff: 'Difficulty', e_time: 'Time',
  e_kills: 'Enemies neutralised', e_heads: 'Headshots', e_stealth: 'Stealth kills', e_vehicles: 'Vehicles and guns destroyed', e_spotted: 'Times spotted',
  e_acc: 'Accuracy', e_score: 'Score', e_rank: 'Rank', e_best: 'Best result', e_newBest: 'New record!', mainMenu: 'Main menu',
  playAgain: 'Play again', medal_S: 'Medal "For the Liberation of Shusha"', medal_A: 'Medal "For Bravery"',
  medal_B: 'Medal "For Military Merit"', medal_C: 'Medal "For Distinction in Battle"',
  mapTitle: 'MAP', mapYou: 'You', mapObj: 'Objective', mapEnemy: 'Enemy',
  s_sens: 'Mouse sensitivity', s_fov: 'Field of view', s_invert: 'Invert Y', s_master: 'Master volume', s_music: 'Music',
  s_sfx: 'Sound effects', s_quality: 'Graphics quality', q_low: 'Low', q_medium: 'Medium', q_high: 'High',
  s_blur: 'Motion blur', s_killcam: 'Kill cam', s_subs: 'Subtitles', s_binds: 'Key bindings',
  s_reset: 'Reset to defaults', pressNew: 'Press a new key…', s_game: 'Game', s_audio: 'Audio', s_video: 'Video',
  a_forward: 'Forward', a_back: 'Back', a_left: 'Left', a_right: 'Right', a_jump: 'Jump / vault', a_sprint: 'Sprint / hold breath',
  a_crouch: 'Crouch', a_prone: 'Prone', a_leanL: 'Lean left', a_leanR: 'Lean right', a_fire: 'Fire', a_aim: 'Aim',
  a_reload: 'Reload', a_weapon1: 'Pistol', a_weapon2: 'Primary 1', a_weapon3: 'Primary 2',
  a_suppressor: 'Attach / detach suppressor', a_fireMode: 'Fire mode', a_interact: 'Interact / takedown / drag',
  a_melee: 'Knife strike', a_throw: 'Throw selected item', a_cycleThrow: 'Cycle throwables', a_c4: 'Place / detonate C4',
  a_medkit: 'Medkit', a_bandage: 'Bandage', a_nvg: 'Night vision', a_wheel: 'Equipment wheel', a_map: 'Map', a_pause: 'Pause',
  creditsText: 'Design and programming: built with Claude (Anthropic).\nEngine: Three.js (MIT licence).\nPlatform: Higgsfield.\nModels, textures and sounds are generated procedurally; any additional assets are listed in design/assets.csv.\n\nThis game is a work of fiction inspired by the battle for Shusha in November 2020. There are no civilians in the game; the city is presented as evacuated.',
  r_start: 'Commander: {name}, do you copy? The fog is on our side. Advance quietly.',
  r_crouch: 'Commander: Stay low and keep to the shadows. Run upright and they will hear you.',
  r_sentry: 'Commander: Lone sentry ahead. Come up behind him and use the knife.',
  r_body: 'Commander: Hide the body in the bushes. If they find it, the whole sector wakes up.',
  r_stone: 'Commander: Throw a stone and pull their attention away.',
  r_radio: 'Commander: The radio operator reports in often. Take him out and you must move fast.',
  r_suppressor: 'Commander: The suppressor will not last forever. Count every round.',
  r_svd: 'Commander: You found a marksman rifle. Remember, its report wakes the mountains.',
  r_cliff: 'Commander: {name}, you are at the foot of the cliff. Ready your gear. Shusha waits above.',
  r_climbHold: 'Commander: Patrol above! Hold still.', r_climbGo: 'Commander: They have passed. Climb.',
  r_city: 'Commander: {name}, you are at the edge of the city. Clear the streets sector by sector.',
  r_c4: 'Commander: Blow the comms relay with C4 and their reinforcements are cut off.',
  r_sectorClear: 'Commander: Sector clear. Good work, {name}. Move to the next one.',
  r_reinforce: 'Commander: Heads up, enemy reinforcements inbound!', r_spotted: 'Commander: You are spotted! Change position!',
  r_lost: 'Commander: They lost you. Back to the shadows.', r_checkin: 'Commander: The operator is not answering. The enemy is suspicious.',
  r_final: 'Commander: {name}, forward! The city centre is ahead. Dawn is breaking.',
  r_flag: 'Commander: The square is ours. Raise the flag, {name}!', r_end: 'Commander: Shusha is free. The homeland thanks you, {name}.',
  r_lowhp: 'Commander: You are wounded! Find cover and dress that wound.',
  r_tank: 'Commander: Hear that engine? There is a tank in the market square. Keep out of its front. Come up behind it and put C4 on the engine deck.',
  r_tank4: 'Commander: A tank is guarding the flag. Blow it up, or slip past it unseen.',
  r_battery: 'Commander: Their guns are firing from the outpost. One charge by each gun will silence them. There is C4 by their ammunition crates.',
  r_tankTrack: 'Commander: You broke its track and it is stuck, but it can still shoot. Hit the engine deck!',
  r_tankDown: 'Commander: The tank is burning! Good work, {name}.', r_batteryDown: 'Commander: The guns are silent. Our people thank you.',
  q_auto: 'Auto',
};

export const STRINGS = { az, en };
export const LANGS = ['az', 'en'];

let current = 'az';
export function setLang(l) { current = STRINGS[l] ? l : 'az'; }
export function getLang() { return current; }

/** Translate a key in the current language, substituting {placeholders}. */
export function t(key, params) {
  let s = STRINGS[current][key];
  if (s === undefined) s = STRINGS.en[key];
  if (s === undefined) return key;
  if (params) {
    for (const k in params) s = s.split('{' + k + '}').join(String(params[k]));
  }
  return s;
}

/**
 * Sanitise a soldier name: strip control characters and markup-ish symbols,
 * collapse whitespace, trim, cap at 20 characters. Letters of any script are
 * kept (so Ə ə Ğ ğ I ı İ i Ö ö Ü ü Ç ç Ş ş all work), plus digits, space, - ' .
 * Returns '' when the result is shorter than 2 characters.
 */
export function sanitizeName(raw) {
  let s = String(raw ?? '').normalize('NFC');
  s = s.replace(/[^\p{L}\p{M}\p{N} \-'.]/gu, '');
  s = s.replace(/\s+/g, ' ').trim();
  s = Array.from(s).slice(0, 20).join('').trim();
  return Array.from(s).length >= 2 ? s : '';
}

/** Human label for a physical key code, for prompts and the bindings screen. */
export function keyLabel(code) {
  if (!code) return '—';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code === 'Mouse0') return 'LMB';
  if (code === 'Mouse1') return 'MMB';
  if (code === 'Mouse2') return 'RMB';
  const map = { Space: 'Space', ShiftLeft: 'Shift', ShiftRight: 'R-Shift', ControlLeft: 'Ctrl', ControlRight: 'R-Ctrl',
    AltLeft: 'Alt', AltRight: 'R-Alt', Tab: 'Tab', Escape: 'Esc', Enter: 'Enter', Backquote: '`', CapsLock: 'Caps',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
  return map[code] || code;
}
