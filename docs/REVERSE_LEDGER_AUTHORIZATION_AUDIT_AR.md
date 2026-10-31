# سجل تدقيق التفويض للدفتر العكسي — ANAS ERP

**التاريخ:** 2026-10-31  
**الفرع:** `feat/atomic-reverse-ledger`  
**النطاق:** تأسيس سياسة تفويض خادمية مستقلة قبل السماح بترحيل المرتجعات والإلغاءات والتسويات.

## أدلة الحالة عند بدء هذه الدفعة

- رأس PR #249 قبل هذه الدفعة: `2d2edd6c43cf3acce6232b9a9e61008eb13a0523`.
- `main` يبقى مجمداً على `507f4a1bbd4e5071edbcb531c8232bd674494850`.
- PR #248 وPR #249 مفتوحان وDraft.
- `executeReturnTransaction()` موجود في `reverse-ledger/reverse-ledger.js`، لكن البحث النصي أثبت غياب `authorization`, `permission`, `periodStatus`, و`operationId` من النواة في هذه النسخة.
- Firebase Snapshot Worker يتحقق من هوية Firebase عند عمليات النسخ، لكنه ليس endpoint لتفويض أو ترحيل الحركات المالية.
- قواعد Firestore الحالية تحصر وصول المستخدم إلى snapshot الخاص به؛ ولا تنشئ نظام صلاحيات مالية تفصيلية.

## ما أضيف في هذه الدفعة

- `reverse-ledger/authorization.js`: سياسة قرار مغلقة افتراضياً لصلاحيات العمليات العكسية.
- `tests/reverse_ledger_authorization.test.js`: اختبارات سلبية وإيجابية للتحقق من الهوية، الصلاحيات الدقيقة، الفترة المفتوحة، الإصدار 2، تسوية السجلات القديمة، السيولة، المخزون، وحجز منع التكرار.
- هذا السجل يميز صراحة بين سياسة القرار وبين محول الخادم الذي يتحقق من JWT ويقرأ الصلاحيات ويحجز `operationId` ذرياً.

## صلاحيات العملية

- `reverse_sale_return`
- `reverse_purchase_return`
- `reverse_invoice_cancel`
- `reverse_cash_refund`
- `reverse_credit_issue`
- `reverse_liquidity_override`
- `reverse_legacy_reconcile`

## حدود السلامة وعدم الادعاء

هذه الوحدة **ليست بحد ذاتها نظام مصادقة أو تخزيناً ذرياً**. لا تتحقق من توقيع JWT ولا تقرأ Firestore ولا تحجز المعرّف. يجب استدعاؤها من Worker مخصص بعد تحقق Firebase على الخادم، وقراءة Grant موثوق، والتحقق من حالة الفترة والمخزون والسيولة، وإنشاء حجز durable/idempotent. لا يجوز تمرير هذه الحقول من المتصفح أو اعتبار `AppData.currentUser` مصدراً للثقة.

لم يتم ربط الوحدة بـ `executeReturnTransaction()` أو تفعيل زر الترحيل في هذه الدفعة؛ لأن ذلك قبل وجود نقطة خادمية ذرية سيخلق حماية شكلية قابلة للتجاوز.

## بوابة الاستكمال

1. إنشاء مخزن Grants محمي، مع آلية موثوقة لتعيين المدير العام الأول دون منح المستخدم لنفسه الصلاحيات.
2. إنشاء Worker منفصل للعمليات العكسية يتحقق من Firebase ID token ويقرأ Grant والفترة والرصيد من المصدر الخادمي.
3. حجز `operationId` ذرياً وربطه بمعاملة Firestore/مخزن معاملات يدعم atomic commit.
4. جعل محرك المتصفح واجهة طلب فقط، ومنع أي ترحيل محلي عند غياب الخادم.
5. تشغيل اختبارات Node وChromium والبوابات الخمس على SHA محدد قبل اعتبار العمل جاهزاً.

## حالة الإنتاج

لا تغيير على `main`، ولا نشر إنتاج، ولا دمج PR #248 أو PR #249. هوية الإنتاج تبقى ANAS ERP v42.

## سجل التنفيذ والفحص — 2026-10-31

### التغييرات المسجلة على الفرع

- `5331e3cff233e3518c05ff86568cba802ea839ff`: إضافة سياسة التفويض المغلقة افتراضياً.
- `3c7f6033e15ab9c5f39613c5b5646a6545e41c91`: تصحيح حالة الاختبار الإيجابية لتسوية السجلات القديمة.
- `4df24aad1ed12e1d98c4ffb8cf93a6fd57b17dd4`: إدراج اختبار التفويض في بوابة HTML Regression.
- `03e0db0b4bd2cec1728cacdc7bad7b7d7a8fe1b6`: إصلاح fixtures لاختبارات حركات المخزون بإضافة نوع الحركة المتوقع `RETURN_IN` / `RETURN_OUT`.
- `8b5e7852138640e0fbd03e828594c26792b5a176`: إصلاح فحص HTML Regression الذي ظل يستخدم قائمة optional arrays قديمة ولم يتضمن `customerCreditMovements`.

### تشخيص فشل CI الفعلي

- تشغيل Safety Checks رقم 155 على SHA `4df24aad...` كشف 3 حالات فشل في fixtures القديمة: سجل حركة المخزون لم يتضمن `type` المطلوب، فرفضه مدقق النواة قبل الوصول إلى assertions المقصودة.
- تشغيل HTML Regression رقم 845 على SHA `4df24aad...` وصل إلى فحوصات التطبيق، ثم فشل بسبب عدم تطابق قائمة `optionalArrays` في validator مع المصدر؛ المصدر كان قد أضاف `customerCreditMovements`، بينما ظل الاختبار يتوقع القائمة القديمة.
- Staging Test Gate رقم 221 أظهر الفشل نفسه في التحقق من استعادة السحابة؛ لذلك تم تحديث عقد الاختبار لا إضعاف مدقق التطبيق.
- أضيفت إصلاحات الاختبارات إلى الفرع، ولا تُعد ناجحة حتى يعيد GitHub Actions تشغيلها ويعرض `success` على SHA جديد.

### حدود التنفيذ الحالية

- سياسة التفويض منفصلة ومختبرة، لكنها لم تُربط بعد بمحرك `executeReturnTransaction()` ولا بواجهة الترحيل.
- لا يوجد بعد Worker مالي مخصص أو مخزن صلاحيات موثوق أو حجز Firestore ذري لـ `operationId`.
- لذلك لا يجوز اعتبار العمليات العكسية آمنة للتشغيل الحي، ولا يجوز تفعيل زر الترحيل.

## سجل إغلاق جولة الفحص — 2026-10-31

### حاجز الترحيل في الواجهة

- الالتزام `78b3badb4f7f830146bbaf5b2be40e7ddddccc14`: إزالة الاستدعاء المحلي المباشر لـ `executeReturnTransaction(AppData, ...)` من نقطة دخول الترحيل.
- أصبح `anasExecuteReversePosting()` يرفض التنفيذ عند غياب `globalThis.ANASReverseLedgerServer.execute`، ولا يقبل إلا بوابة غير متزامنة تعيد `{ok:true, document}`.
- لا يوجد حالياً adapter خادمي بهذا العقد؛ لذلك تبقى جميع عمليات المرتجعات والإلغاءات محجوبة عمداً ولا تتغير البيانات المحلية.
- تم التحقق نصياً من عدم وجود أي استدعاء لـ `executeReturnTransaction(` داخل `index.html`.

### اختبارات واجهة Chromium

- الالتزام `594e490a56e1d195295c41f40e167430bcb7a0d6`: تحديث اختبار واجهة البيع/الشراء/الإلغاء ليتحقق من الرفض المغلق بدلاً من افتراض السماح بترحيل محلي.
- الالتزام `884a3567d01a70ebc8619bb3efa740c0a626c7b1`: إضافة اختبار Chromium لمسارات الواجهة الثلاثة.
- الالتزام `baba2a3238fa5b2ab92972d1956dd9bc65219772`: إصلاح محدد استخراج دالة الواجهة في اختبار Chromium.
- تقرير Chromium الفعلي:
  - `saleBlocked=true`
  - `purchaseBlocked=true`
  - `cancelBlocked=true`
  - `saleUnchanged=true`, `purchaseUnchanged=true`, `cancelUnchanged=true`
  - `localEngineCalls=0`
- اجتازت اختبارات Chromium الأخرى الخاصة باستعادة النسخة، التطابق المحاسبي للمشتريات والموردين، إعادة التحميل، ودفتر العميل.

### بوابات GitHub Actions على SHA

`baba2a3238fa5b2ab92972d1956dd9bc65219772`

- ANAS ERP Safety Checks: SUCCESS — run `41148296103`.
- ANAS ERP HTML Regression Checks: SUCCESS — run `41148296203`.
- Firebase Snapshot Worker Tests: SUCCESS — run `41148296138`.
- Staging Test Gate: SUCCESS — run `41148296134`.
- ANAS ERP Service Worker Cache Regression: SUCCESS — run `41148296146`.

### ما لم يكتمل بعد — لا تُعلن الجاهزية النهائية

- لم يُنشأ بعد Worker مالي منفصل للتحقق الخادمي من Firebase ID token وقراءة Grant موثوق.
- لا يوجد حتى الآن مخزن Grants مع تعيين آمن للمدير العام الأول.
- لا يوجد بعد حجز ذري دائم لـ `operationId` ولا معاملة خادمية واحدة تشمل المستند والدفاتر والمخزون والسيولة.
- تقرير Chromium الحالي يثبت بوابة الرفض المغلق واختبارات primitive والاستعادة، لكنه **ليس** التقرير الكامل المطلوب ذي الحقول العشرة ولا يثبت سيناريوهات الترحيل الاثني عشر.
- لذلك لا تُسجل هذه المرحلة كـ `5/5` قبول نهائي، ولا يُفعّل الترحيل، ولا يُدمج أي PR.

### ثبات الإنتاج

- `main` بقي على `507f4a1bbd4e5071edbcb531c8232bd674494850`.
- PR #248 وPR #249 بقيا مفتوحين وDraft.
- لا نشر إنتاج، وهوية التطبيق تبقى ANAS ERP v42.


## متابعة التدقيق — إصلاح رسائل الرفض وإعادة إثبات البوابات (2026-10-31)

### إصلاح دقيق في واجهة الرفض المغلق

- الالتزام `bfecefbc218308972d26a67217b5468da571f4ce`: إزالة تكرار عبارة «لم تتغير أي بيانات» التي كانت تظهر مرتين في رسالة رفض غياب البوابة الخادمية.
- الالتزام `dde9b43b66b2e83b2af47fad641170379ec8cf9f`: إضافة assertion في Chromium يمنع عودة تكرار نص الرفض.
- السبب: رسالة خطأ البوابة نفسها كانت تحتوي على تأكيد عدم التغيير، ثم كان catch يضيف تأكيداً ثانياً. أصبح النص الآن يعرض سبب الرفض مرة واحدة، ويتبعه تأكيد عدم اعتماد نجاح محلي.

### تحقق Chromium الفعلي على الالتزام `dde9b43b...`

- اختبارات Node المالية المجمعة: `27 passed / 0 failed`.
- مجموعة Chromium: `5 passed / 0 failed`.
- `CHROMIUM_REVERSE_RESTORE_GUARD_REPORT`:
  - قبول النسخة القديمة والنسخة الصحيحة.
  - رفض السجل اليتيم وتجاوز حد المرتجع في النسخة والنسخة السحابية.
  - `appUnchanged=true`, `localStorageUnchanged=true`.
- `CHROMIUM_LEDGER_REPORT`:
  - تطابق سنتيمات الصندوق والمورد ووحدات المخزون BigInt.
  - إعادة تحميل واستعادة نسخة احتياطية ناجحتان.
  - `deepRestoreEquality=PASS`.
- `CHROMIUM_CUSTOMER_LEDGER_REPORT`:
  - رصيد الدين النهائي `1000005` سنتيم.
  - رفض التخصيص الزائد دون تغيير.
  - rollback وإعادة التحميل ناجحان.
- `CHROMIUM_REVERSE_LEDGER_REPORT`:
  - primitive parity صالح، السجلات القديمة قابلة للقراءة، تجاوز كمية المرتجع مرفوض.
- `CHROMIUM_REVERSE_LEDGER_FAIL_CLOSED_REPORT`:
  - `responseIsNull=true`, `unchanged=true`, `localEngineCalls=0`.
- `CHROMIUM_REVERSE_UI_FAIL_CLOSED_REPORT`:
  - حظر مرتجع المبيعات ومرتجع المشتريات والإلغاء.
  - لا تغيير في الحالة في الحالات الثلاث، ولا استدعاء للمحرك المحلي.

**حد التقرير:** هذه النتائج تثبت اختبارات primitive والرفض المغلق والاستعادة والتطابق المالي المحددة أعلاه. لا تثبت بعد سيناريوهات الترحيل الاثني عشر المطلوبة، ولا تنتج `CHROMIUM_REVERSE_LEDGER_FULL_REPORT` ذي الحقول العشرة.

### بوابات CI على SHA موحد

الالتزام: `dde9b43b66b2e83b2af47fad641170379ec8cf9f`

- ANAS ERP Safety Checks: SUCCESS — run `41150182262` / check `41150186500`.
- ANAS ERP HTML Regression Checks: SUCCESS — check `41150186518`.
- Firebase Snapshot Worker Tests: SUCCESS — check `41150186515`.
- Staging Test Gate: SUCCESS — run `41150182263` / check `41150186536`.
- ANAS ERP Service Worker Cache Regression: SUCCESS — check `41150186502`.

### ثبات الفرع والإنتاج

- رأس فرع العمل عند هذا التحقق: `dde9b43b66b2e83b2af47fad641170379ec8cf9f`.
- `main` ما زال `507f4a1bbd4e5071edbcb531c8232bd674494850`.
- PR #249 ما زال مفتوحاً وDraft، وPR #248 ما زال مفتوحاً وDraft.
- هوية التطبيق في `index.html` ما زالت ANAS ERP v42.
- لم يحدث دمج أو نشر إنتاج.

### العقبات المفتوحة التي تمنع اعتماد المرتجعات

1. لا يوجد Worker مالي فعلي يحقق Firebase ID token ويقرأ Grant من مصدر موثوق.
2. قواعد Firestore الحالية تسمح للمستخدم بالكتابة إلى snapshot الخاص به؛ لا تمثل تفويضاً محاسبياً ولا تصلح لتخزين صلاحيات مالية موثوقة.
3. لا يوجد حجز ذري دائم لـ `operationId` ولا transaction خادمية تضم جميع دفاتر العملية.
4. محرك النواة ما زال يرفض بعض قيم السطر ذات الكسور الدورية بدلاً من تطبيق Cumulative Delta Valuation.
5. حركة `SALE_OUT` التاريخية لا تحمل تكلفة الخروج المحفوظة، ولا يوجد حتى الآن أساس كافٍ لإرجاع المخزون بتكلفة البيع التاريخية.
6. مرتجع الشراء لا يسجل حتى الآن فرق تقييم WAC عن تسوية المورد في حساب variance مستقل.

**قرار السلامة:** نجاح البوابات الخمس لا يغير هذه القيود. يظل الترحيل العكسي محجوباً من الواجهة، ولا يجوز اعتبار النظام جاهزاً لتشغيل المرتجعات أو إلغاء الفواتير.


## مرحلة التقييم المحاسبي المستقل — 2026-10-31

### الوحدة الجديدة

- `reverse-ledger/valuation.js`: وحدة حسابية مستقلة، لا تعتمد على DOM أو AppData ولا تنفذ ترحيلاً.
- `tests/reverse_ledger_valuation.test.js`: اختبارات وحدة لحسابات BigInt.
- تم إدراج اختبارات الوحدة في كل من HTML Regression وSafety Checks.

### قواعد الحساب المثبتة في الوحدة

1. `cumulativeValueCentimes`: تقريب نصف لأعلى باستخدام BigInt، دون IEEE-754.
2. `cumulativeDeltaCentimes`: قيمة المرتجع هي فرق القيمة التراكمية قبل وبعد الكمية الجديدة؛ مثال 100 سنتيم / 3 وحدات ينتج 33 + 34 + 33 = 100.
3. `saleReturnInventoryValuation`: يعيد المخزون بتكلفة البيع التاريخية المدخلة، ثم يعيد حساب متوسط التكلفة المرجح من قيمة المخزون الحالية مضافاً إليها التكلفة التاريخية المستردة.
4. `purchaseReturnInventoryValuation`: يفصل تسوية المورد عن القيمة الدفترية الخارجة وفق WAC، ويعيد فرق التقييم بإشارة موثقة:
   - موجب: تسوية المورد أعلى من القيمة الدفترية المستبعدة.
   - سالب: تسوية المورد أقل من القيمة الدفترية المستبعدة.
5. ترفض الوحدة الكميات السالبة أو المتجاوزة، الأساس الكمي الصفري، المخزون غير المتاح، وقيمة مخزون موجبة مع كمية مخزون صفرية.

### حدود التكامل

هذه الوحدة **مكتملة كحسابات مستقلة فقط**؛ لم تُربط بعد بـ `executeReturnTransaction()`. ما زال محرك المرتجعات يرفض السطر ذي القيمة الكسرية في مساره الحالي، ولا تزال بيانات `SALE_OUT` لا توفر تكلفة الخروج التاريخية اللازمة. لن أستبدل منطق المحرك قبل ترحيل هذه الحقول والتحقق منها في فواتير وحركات المخزون الأصلية، مع اختبارات تسلسل المرتجعات وإعادة بناء الكميات السابقة من المستندات المنشورة.

### إصلاحات CI المصاحبة

- تم إضافة اختبار تقييم Cumulative Delta وWAC إلى بوابتي HTML Regression وSafety Checks.
- تم إصلاح اختبار Legacy Customer Debt الذي ظل يتوقع تحصيلاً بمطالبة واحدة، بينما أصبح المسار يتطلب تخصيصاً صريحاً للدفعات؛ وأعيد استخدام `tests/customer_debt_collection_guard_test.js` كمصدر اختبار موحد.
- تم إصلاح اختبار Legacy Invoice UI ليحقن التبعيات الآمنة المطلوبة، بدلاً من تشغيل handlers معزولة دون دوالها المساعدة.
- تم تصحيح رسالة الرفض المغلق لإزالة النقاط المكررة، وإضافة تحقق Chromium يمنع تكرار علامات الوقف.

### نتائج التحقق على بصمة الكود

**SHA:** `b0f469f0c25c61dc2f50ce6ebb08cb037068a9a1`

- ANAS ERP Safety Checks: SUCCESS — run `41150817574`.
- HTML Regression: SUCCESS — run `41150817435`.
- Firebase Snapshot Worker Tests: SUCCESS — run `41150817490`.
- Staging Test Gate: SUCCESS — run `41150817631`.
- Service Worker Cache Regression: SUCCESS — run `41150817511`.
- Workflow YAML Syntax Validation: SUCCESS — run `41150817585`.
- Legacy Manual Safety Suite: SUCCESS — run `41150817449`.

### تقارير Chromium الفعلية على SHA نفسه

- Node financial suite: `27 passed / 0 failed`.
- Chromium suite: `5 passed / 0 failed`.
- `CHROMIUM_REVERSE_LEDGER_FAIL_CLOSED_REPORT`: `responseIsNull=true`, `unchanged=true`, `localEngineCalls=0`.
- `CHROMIUM_REVERSE_UI_FAIL_CLOSED_REPORT`: `saleBlocked=true`, `purchaseBlocked=true`, `cancelBlocked=true`; الحالة لم تتغير في المسارات الثلاثة.
- تقارير الاستعادة ودفتر العميل والمورد والمخزون اجتازت assertions المسجلة في سجلات التشغيل.

**حد القبول:** لم يُنشأ بعد `CHROMIUM_REVERSE_LEDGER_FULL_REPORT` بالحقول العشرة، ولم تُنفذ سيناريوهات الترحيل الاثني عشر؛ نتائج Chromium الحالية تثبت الرفض المغلق والـ primitives والاستعادة والتطابقات المحددة فقط.

### حالة الإنتاج والفرع

- `main` ثابت على `507f4a1bbd4e5071edbcb531c8232bd674494850`.
- PR #248 وPR #249 مفتوحان وDraft.
- هوية الإنتاج ANAS ERP v42 محفوظة.
- لا دمج ولا نشر إنتاج.


## تنفيذ بوابة الحجز الخادمية — 2026-10-31

### ما أُنشئ على الفرع

- `cloudflare/worker_reverse_ledger.js`: Worker مستقل للتحقق من هوية Firebase عبر Identity Toolkit، ومطابقة `sub/user_id/aud/iss/auth_time/iat/exp` مع مشروع Staging، ثم استخدام هوية Service Account خادمية لقراءة وثائق التحكم.
- `cloudflare/wrangler-reverse-ledger-staging.toml`: إعداد معزول لمشروع `anas-erp-staging-a25e1`، منفصل عن Worker الإنتاج.
- `firebase/firestore.reverse-ledger.rules`: قواعد مستقلة تمنع العميل من قراءة أو تعديل Grants والفترات والحجوزات. كما أضيفت قيود التحكم إلى ملف القواعد الفعلي `firebase/firestore.rules` المشار إليه في `firebase.json`.
- `tests/worker_reverse_ledger.test.mjs`: اختبارات CORS، غياب الهوية، claims، الصلاحيات، قواعد Firestore، إعداد Staging، والحجز الذري.

### آلية الحجز

1. لا يقبل Worker سوى `operationId/type/invoiceId/periodId`؛ ويرفض أي مبالغ أو أرصدة أو قيود مالية يرسلها المتصفح.
2. يتحقق من Firebase ID token ومطابقة المشروع والوقت.
3. يبدأ Firestore read-write transaction.
4. يقرأ Grant المستخدم، والفترة المالية، وسجل العملية ضمن المعاملة نفسها.
5. يرفض العملية عند غياب Grant أو الصلاحية الدقيقة أو كون الفترة مغلقة أو وجود `operationId` سابق.
6. ينشئ وثيقة الحجز بشرط `currentDocument.exists=false` داخل معاملة Firestore نفسها؛ وبذلك لا توجد نافذة سباق بين فحص التكرار وإنشاء الحجز.
7. عند فشل التحقق يجري rollback للمعاملة، ولا ينشئ الحجز.

### إثبات الاختبارات

- تشغيل `Firebase Snapshot Worker Tests` على الالتزام `f6564ab3eb21fa1df47552175f1a9e0d3b13795a`: **53/53 ناجحة**، دون إخفاق.
- يشمل الاختبار إثبات بدء المعاملة وقراءة المستندات الثلاثة داخلها، ثم كتابة واحدة مشروطة بغياب المستند، ورفض إعادة استخدام معرّف العملية دون commit ثانٍ.
- تم توصيل اختبارات Worker إلى Firebase Snapshot Worker Tests وANAS ERP Safety Checks وHTML Regression.

### ما لم يُنجز بعد — حد أمان صريح

- هذه البوابة **تحجز العملية فقط**؛ لا تنفذ عكس الفاتورة ولا حركات النقد أو المخزون أو حسابات العميل/المورد.
- `postingEnabled=false` ثابت في استجابة Health والحجز. لا يوجد مسار `/post`، وأي طلب إليه يعاد بـ 404.
- لا يزال يلزم بناء محرك commit خادمي يقرأ الفاتورة الأصلية وسجلها وتخصيصاتها وتكلفة المخزون من مصادر موثوقة، ويشتق المبالغ على الخادم، ثم يكتب المستند والدفاتر والمخزون والنقد وتغيير حالة الحجز ضمن **معاملة Firestore واحدة**.
- يلزم اعتماد مخطط وثائق Grants والفترات، وإعداد Service Account محدود الصلاحيات، وتكوين أسرار Cloudflare Staging، ونشر قواعد Firestore والتحقق من قراءتها فعلياً قبل نشر Worker.
- لم يتم نشر Worker الجديد، ولم تُنشأ أي أسرار، ولم تتغير بيانات الإنتاج.
- لا تُعد هذه الخطوة تفويضاً نهائياً للترحيل، ولا تسمح بتفعيل زر الترحيل أو دمج PR.

### ثبات الإنتاج

- `main` يبقى عند `507f4a1bbd4e5071edbcb531c8232bd674494850`.
- PR #248 وPR #249 يبقيان Draft.
- هوية ANAS ERP الإنتاجية تبقى V42.
