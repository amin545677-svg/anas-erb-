(function () {
  'use strict';
  if (window.__ANAS_AI_EXCEL_IMPORT_UI__) return;
  window.__ANAS_AI_EXCEL_IMPORT_UI__ = true;
  const TYPES = [
    ['auto', 'تلقائي', '✦'], ['products', 'منتجات', '▣'],
    ['customers', 'عملاء', '♙'], ['suppliers', 'موردون', '▤'],
    ['invoices', 'فواتير', '▧'], ['inventory', 'مخزون', '▥']
  ];
  const ACCEPTED = new Set(['xlsx', 'xls', 'csv', 'pdf', 'jpg', 'jpeg', 'png']);
  const MAX_TABLE_BYTES = 2 * 1024 * 1024;
  const MAX_IMAGE_PDF_BYTES = 10 * 1024 * 1024;

  function mount() {
    const hub = document.getElementById('view-ai-excel-hub');
    const input = document.getElementById('smartAiExcelUpload');
    if (!hub || !input || hub.querySelector('[data-anas-ai-import-ui]')) return false;
    const panel = document.createElement('section');
    panel.className = 'anas-ai-import-pro';
    panel.setAttribute('data-anas-ai-import-ui', '');
    panel.setAttribute('dir', 'rtl');
    panel.setAttribute('aria-labelledby', 'anasAiImportTitle');
    const typeButtons = TYPES.map(function (item, index) {
      return '<button type="button" class="anas-ai-import-type' + (index === 0 ? ' is-active' : '') +
        '" data-import-type="' + item[0] + '" aria-pressed="' + (index === 0 ? 'true' : 'false') +
        '"><span aria-hidden="true">' + item[2] + '</span><b>' + item[1] + '</b></button>';
    }).join('');
    panel.innerHTML = [
      '<header class="anas-ai-import-head"><div class="anas-ai-import-orb" aria-hidden="true">✦</div>',
      '<div class="anas-ai-import-head-copy"><span class="anas-ai-import-kicker">ANAS AI · SMART DATA IMPORT</span>',
      '<h2 id="anasAiImportTitle">استيراد Excel بالذكاء الاصطناعي</h2>',
      '<p>حلّل ملفاتك، تعرّف على الأعمدة، وراجع النتائج قبل حفظ أي بيانات</p></div>',
      '<span class="anas-ai-import-head-check" aria-label="تحليل محلي آمن">✓</span></header>',
      '<div class="anas-ai-import-benefits"><div><b>Excel / CSV</b><small>استيراد الجداول</small></div>',
      '<div><b>✦ ذكي</b><small>تعرّف تلقائي على الأعمدة</small></div>',
      '<div><b>◉ دقيق</b><small>مراجعة قبل الحفظ</small></div><div><b>▱ آمن</b><small>لا حفظ جزئي</small></div></div>',
      '<div class="anas-ai-import-section-title"><h3>ما البيانات التي تريد استيرادها؟</h3><span>يمكنك ترك الاختيار تلقائياً</span></div>',
      '<div class="anas-ai-import-types" role="group" aria-label="نوع البيانات">' + typeButtons + '</div>',
      '<div class="anas-ai-import-drop" role="group" aria-label="اختيار ملف الاستيراد">',
      '<div class="anas-ai-import-file-icon" aria-hidden="true">XLS</div>',
      '<h3>أضف ملف Excel أو اسحبه هنا</h3><p>يدعم Excel وCSV وPDF والصور · تحليل أولي قبل الاستيراد</p>',
      '<button type="button" class="anas-ai-import-primary" data-import-action="file">اختيار ملف من الجهاز <span aria-hidden="true">↗</span></button>',
      '<div class="anas-ai-import-status" role="status" aria-live="polite">لم يتم اختيار أي ملف بعد</div></div>',
      '<div class="anas-ai-import-actions"><button type="button" data-import-action="camera"><span>▣</span> التقاط بالكاميرا</button>',
      '<button type="button" data-import-action="gallery"><span>▧</span> من المعرض</button></div>',
      '<div class="anas-ai-import-rules"><div><b>الصيغ المدعومة</b><span>XLSX · XLS · CSV · PDF · JPG · PNG</span></div>',
      '<div><b>حدود الملف</b><span>2MB للجداول · 10MB للصور وPDF</span></div>',
      '<div><b>حماية البيانات</b><span>لا يتم حفظ أي سجل قبل المعاينة والتحقق</span></div></div>',
      '<div class="anas-ai-import-note"><span>✦</span><p><b>المساعد الذكي</b> يكتشف عناوين الأعمدة والتنسيقات ويقترح المطابقة. راجع التغييرات والتكرارات قبل اعتماد الاستيراد.</p></div>'
    ].join('');
    hub.insertBefore(panel, hub.firstChild);
    let selectedType = 'auto';
    const status = panel.querySelector('.anas-ai-import-status');
    function announce(message, kind) {
      status.textContent = message;
      status.dataset.state = kind || 'info';
    }
    function publishType(type) {
      selectedType = type;
      const label = (TYPES.find(function (item) { return item[0] === type; }) || TYPES[0])[1];
      window.ANAS_AI_IMPORT_CONTEXT = Object.freeze({
        entityType: type, label: label, selectedAt: Date.now(), source: 'ai-excel-import-ui'
      });
      panel.querySelectorAll('[data-import-type]').forEach(function (button) {
        const active = button.dataset.importType === type;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
      window.dispatchEvent(new CustomEvent('anas:import-target-selected', {
        detail: { entityType: type, label: label }
      }));
    }
    function validateFile(file) {
      if (!file) return 'لم يتم اختيار ملف.';
      const extension = String(file.name || '').split('.').pop().toLowerCase();
      if (!ACCEPTED.has(extension)) return 'صيغة الملف غير مدعومة. اختر Excel أو CSV أو PDF أو صورة.';
      const limit = ['pdf', 'jpg', 'jpeg', 'png'].includes(extension) ? MAX_IMAGE_PDF_BYTES : MAX_TABLE_BYTES;
      if (file.size > limit) return 'حجم الملف أكبر من الحد المسموح لهذا النوع.';
      if (!file.size) return 'الملف فارغ ولا يحتوي على بيانات.';
      return '';
    }
    function acceptCameraFile(file) {
      const error = validateFile(file);
      if (error) { announce(error, 'error'); return; }
      try {
        const transfer = new DataTransfer();
        transfer.items.add(file);
        input.files = transfer.files;
        input.dataset.anasEntityHint = selectedType;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        announce('تم تمرير الصورة إلى محرك الاستيراد الحالي للتحليل.', 'success');
      } catch (_) {
        announce('تعذر تمرير الصورة تلقائياً على هذا الجهاز. استخدم زر اختيار الملف.', 'error');
      }
    }
    panel.addEventListener('click', function (event) {
      const typeButton = event.target.closest('[data-import-type]');
      if (typeButton) {
        publishType(typeButton.dataset.importType);
        const label = (TYPES.find(function (item) { return item[0] === selectedType; }) || TYPES[0])[1];
        announce('تم اختيار نوع البيانات: ' + label, 'info');
        return;
      }
      const actionButton = event.target.closest('[data-import-action]');
      const action = actionButton && actionButton.dataset.importAction;
      if (!action) return;
      if (action === 'file' || action === 'gallery') {
        input.dataset.anasEntityHint = selectedType;
        input.setAttribute('accept', action === 'gallery' ? 'image/*' : '.xlsx,.xls,.csv,.pdf,.jpg,.jpeg,.png');
        input.click();
      } else if (action === 'camera') {
        const camera = document.createElement('input');
        camera.type = 'file'; camera.accept = 'image/*';
        camera.setAttribute('capture', 'environment'); camera.hidden = true;
        camera.addEventListener('change', function () {
          acceptCameraFile(camera.files && camera.files[0]); camera.remove();
        }, { once: true });
        document.body.appendChild(camera); camera.click();
      }
    });
    input.addEventListener('change', function (event) {
      const file = input.files && input.files[0];
      const error = validateFile(file);
      if (error) {
        event.stopImmediatePropagation(); input.value = ''; announce(error, 'error'); return;
      }
      input.dataset.anasEntityHint = selectedType;
      const size = file.size < 1024 * 1024
        ? Math.max(1, Math.round(file.size / 1024)) + ' KB'
        : (file.size / (1024 * 1024)).toFixed(1) + ' MB';
      announce('تم اختيار ' + file.name + ' (' + size + '). جارٍ تمريره إلى المعاينة والتحقق.', 'success');
      window.dispatchEvent(new CustomEvent('anas:import-file-selected', {
        detail: { name: file.name, size: file.size, entityType: selectedType }
      }));
    }, true);
    function applyEntityHintToPreview() {
      if (selectedType === 'auto') return false;
      const aliases = {
        products: ['منتجات', 'المنتجات', 'products', 'product'],
        customers: ['عملاء', 'العملاء', 'customers', 'customer'],
        suppliers: ['موردون', 'الموردون', 'الموردين', 'suppliers', 'supplier'],
        invoices: ['فواتير', 'الفواتير', 'invoices', 'invoice'],
        inventory: ['مخزون', 'المخزون', 'inventory', 'stock']
      };
      const wanted = aliases[selectedType] || [];
      const scopes = Array.from(document.querySelectorAll('[id*="smartImport"],[class*="smartImport"],[role="dialog"]'));
      const selects = scopes.reduce(function (all, scope) {
        return all.concat(Array.from(scope.querySelectorAll('select')));
      }, []);
      for (const select of selects) {
        const option = Array.from(select.options || []).find(function (candidate) {
          const text = String(candidate.textContent || '').trim().toLowerCase();
          const value = String(candidate.value || '').trim().toLowerCase();
          return wanted.some(function (alias) {
            const key = alias.toLowerCase();
            return text === key || value === key;
          });
        });
        if (option) {
          select.value = option.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      return false;
    }
    if (typeof window.showSmartImportPreview === 'function' && !window.__ANAS_IMPORT_PREVIEW_HINT_HOOK__) {
      const originalPreview = window.showSmartImportPreview;
      window.showSmartImportPreview = function () {
        const result = originalPreview.apply(this, arguments);
        Promise.resolve().then(applyEntityHintToPreview);
        return result;
      };
      window.__ANAS_IMPORT_PREVIEW_HINT_HOOK__ = true;
    }
    publishType('auto');
    return true;
  }
  if (!mount()) {
    const observer = new MutationObserver(function () {
      if (mount()) observer.disconnect();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener('DOMContentLoaded', function () {
      if (mount()) observer.disconnect();
    }, { once: true });
  }
})();