# تدقيق توحيد نسخة ANAS ERP — V42 مقابل مرشح V54.25
التاريخ: 2026-10-24

## قرار السلامة
لا تُستبدل `main/index.html` بمرشح V54.25 مباشرة. المقارنة البرمجية الأولية أثبتت أن النسختين ليستا مجرد ملف واحد برقم عنوان مختلف؛ تختلف قائمة الدوال، وتوجد دوال في كل نسخة غير موجودة في الأخرى. المطلوب دمج واعٍ للوظائف ثم اختبار كامل.

## هويات الملفات المؤكدة
- `main/index.html` على commit `9167849e19244b411f36758201aae7f6bd3fcfb6`.
- Git blob لـ `main/index.html`: `b2b368bfba153143f20956fd1c9674d5aee95408`.
- عنوان `main`: `Anas ERP v42 - إصلاح الربط السحابي`.
- المرشح المحلي المصحح: `ANAS_ERP_V54_25_RELEASE_CANDIDATE/index.html`.
- بصمة SHA-256 للمرشح المصحح: `926da94cb26a650c68d10dabe9fc2dffdb2244920b41c6f0c7dd0088c9597056`.
- عنوان المرشح المصحح: `ANAS ERP V54.25 - Release Candidate`.
- مرجع manifest في المرشح المصحح: `manifest.webmanifest`.
- المرشح المصحح ليس بعد جزءًا من `main` ولا من نشر الإنتاج.

## نتيجة مقارنة الدوال
- استخرجت المقارنة الأولية 228 اسم دالة من `main/index.html` و245 اسم دالة من المرشح المحلي.
- توجد دوال في `main` لم تظهر في المرشح، منها: `anasAskAiAboutPdf`, `anasDownloadPdfText`, `anasExtractPdfText`, `closePanel`, `labelFor`, `openPanel`, `reportParseDate`, `safeContext`, `wtAvailableStock`, `wtCurrentSaleWarehouse`, `wtEnsureMobileWarehouse`, `wtEnsureUserWarehouse`, `wtUserWarehouseName`.
- توجد دوال في المرشح لم تظهر في `main`، منها: `anasBootPrimaryStorage`, `anasGetIDBStorageStatus`, `anasOpenIDB`, `anasPersistSnapshotToIDB`, `anasReadSnapshotFromIDB`, `anasRequirePermission`, `anasValidateIncomingSyncData`, `ensureMovementArray`, `editUserRecord`, `setPosQty`, `wtEnsureData`, `wtInitStockScreen`, `wtUpdateAvailability`.
- هذه مقارنة أسماء دوال فقط، وليست إثباتًا كافيًا بأن كل وظيفة مفقودة أو متكافئة؛ يجب مقارنة تعريفات الدوال، مستمعات الأحداث، عناصر HTML، مخطط البيانات، الصلاحيات، ومراجع المكتبات.

## خطة الإصلاح الإلزامية
1. تثبيت `main` والمرشح المصحح كبصمتين مرجعيتين وعدم تغيير أي منهما.
2. إعداد جرد دوال وعناصر DOM والمكتبات والأحداث والتخزين والصلاحيات لكل نسخة، مع تصنيف: موجود، مفقود، مختلف، أو متكرر.
3. دمج الميزات المطلوبة من V54.25 على أساس نسخة مرجعية معلنة، مع الحفاظ على الوظائف الفريدة التي ما زالت موجودة في V42. لا يُسمح بنسخ الملف كاملًا فوق الآخر.
4. تشغيل فحوص JavaScript وHTML، واختبارات وظائف المبيعات والفواتير والمخزون والديون والتقارير وPDF/Excel والمستودعات والذكاء الاصطناعي والنسخ السحابي.
5. التحقق من ملفات PWA وmanifest وservice worker والأيقونات كمجموعة واحدة.
6. فتح PR يحتوي التطبيق الموحد فقط بعد اكتمال المقارنة والاختبارات، وعدم الدمج أو النشر قبل مراجعة الفرق ونجاح CI.
7. بعد النشر فقط، التحقق من العنوان والبصمة/commit المنشور والاختبارات الفعلية على HTTPS.

## ممنوعات حتى إغلاق المشكلة
- لا يُغيّر عنوان V42 فقط ليظهر V54.25.
- لا يُستبدل `main/index.html` بمرشح V54.25 الحالي قبل استعادة الوظائف التي لا تظهر في المرشح والتحقق من عدم وجود تغييرات دلالية أخرى.
- لا يُعتبر فحص الصياغة وحده اختبارًا وظيفيًا.
- لا يُنشر إصدار جديد قبل نجاح المقارنة والاختبارات.
- لا تُسجّل أي نتيجة اختبار على أنها ناجحة ما لم تُشاهد نتيجتها الفعلية.

## حالة العمل
هذه الوثيقة تسجل نتائج مقارنة أولية وخطة منع فقد الوظائف. لا تحتوي على تعديل للتطبيق ولا تعني أن مشكلة اختلاف الإصدار قد أُغلقت.

## نتائج إعادة الفحص المحلي للمرشح المصحح
- تم فحص الملف المحلي `ANAS_ERP_V54_25_RELEASE_CANDIDATE/index.html` بعد تصحيح العنوان ومرجع manifest.
- العنوان: `ANAS ERP V54.25 - Release Candidate`.
- الحجم: 569,723 بايت؛ SHA-256: `926da94cb26a650c68d10dabe9fc2dffdb2244920b41c6f0c7dd0088c9597056`.
- 12 كتلة JavaScript مضمنة: صفر أخطاء `node --check`.
- 267 معرّف HTML: لا توجد معرّفات مكررة.
- يشير HTML إلى `manifest.webmanifest` ولا يشير إلى `manifest.json`؛ وتوجد الملفات `manifest.webmanifest` و`sw.js` و`icons/icon.svg` في حزمة المرشح المصحح.
- هذه فحوص ثابتة محلية فقط. لم يتم تشغيل المتصفح الفعلي، أو اختبار جميع الوظائف، أو اختبار HTTPS/Google/Firebase/Workers، أو نشر هذا المرشح.

## سجل العمل المرتبط
- سجل التسليم المحدث: https://github.com/amin545677-svg/anas-erb-/blob/audit/anas-erp-v54-25-handover/ANAS_ERP_V54_25_HANDOVER_AR.md
- اختبارات AI Worker في PR #15: https://github.com/amin545677-svg/anas-erb-/pull/15 (لا تُعد ناجحة حتى تظهر نتائج CI الفعلية).
- هذا PR #16 توثيقي فقط؛ لا يغير التطبيق ولا يغلق مشكلة توحيد النسخ.
