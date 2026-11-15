(function (g) {
  'use strict';
  if (g.__ANAS_LIVE_DURABILITY_STATUS_R46__) return;
  g.__ANAS_LIVE_DURABILITY_STATUS_R46__ = true;
  function bar() { return g.document && g.document.getElementById('anas-live-status-bar'); }
  function syncBuildIdentity() {
    const b = bar(); if (!b) return false;
    const stamp = g.document.getElementById('anasBuildStamp');
    const badge = g.document.getElementById('anas-status-version-badge');
    const raw = stamp && typeof stamp.textContent === 'string' ? stamp.textContent.trim() : '';
    const match = /^Build SHA:\s*([0-9a-f]{7,40}|local)\s*\|\s*SW:\s*(r40)\s*\|\s*Env:\s*Staging$/i.exec(raw);
    if (!match) { b.dataset.buildIdentityState = 'unverified'; if (badge) badge.textContent = '⚠ إصدار غير متحقق'; return false; }
    const sha = match[1].toLowerCase(), version = match[2].toLowerCase();
    b.dataset.buildSha = sha; b.dataset.buildVersion = version; b.dataset.buildIdentityState = 'verified';
    if (badge) badge.textContent = 'SW: ' + version + ' | Build SHA: ' + sha;
    return true;
  }
  function emit(type, detail) {
    if (!g.document || typeof g.CustomEvent !== 'function') return;
    try { g.document.dispatchEvent(new g.CustomEvent(type, { detail: detail || {} })); } catch (_) {}
  }
  function network(forced) {
    const b = bar(); if (!b) return;
    const online = typeof forced === 'boolean' ? forced : (!g.navigator || g.navigator.onLine !== false);
    b.dataset.networkState = online ? 'online' : 'offline';
    const badge = g.document.getElementById('anas-status-network-badge');
    if (badge) badge.textContent = online ? '● متصل' : '● غير متصل';
  }
  function durability(state, label) {
    const b = bar(); if (!b) return;
    b.dataset.durabilityState = state;
    const badge = g.document.getElementById('anas-status-durability-badge');
    if (badge) badge.textContent = label;
  }
  function syncLiveDurabilityStatusBar() {
    if (!bar()) return false;
    const storage = g.ANASResilientStorage, data = g.AppData;
    if (!storage || typeof storage.getCommittedSnapshot !== 'function' ||
        typeof storage.canonicalizeJson !== 'function' || !data ||
        (typeof storage.ready === 'function' && !storage.ready())) {
      durability('uncommitted', '⚠ غير محفوظ'); return false;
    }
    try {
      const committed = storage.getCommittedSnapshot();
      const matches = !!committed &&
        storage.canonicalizeJson(committed) === storage.canonicalizeJson(data);
      durability(matches ? 'committed' : 'uncommitted',
        matches ? '✓ محفوظ بأمان' : '⚠ توجد تغييرات غير محفوظة');
      return matches;
    } catch (_) {
      durability('uncommitted', '⚠ تعذر التحقق من الحفظ'); return false;
    }
  }
  g.syncLiveDurabilityStatusBar = syncLiveDurabilityStatusBar;
  function hookDurableSave() {
    if (typeof g.saveDBDurably !== 'function' || g.saveDBDurably.__anasR40Wrapped) return false;
    const original = g.saveDBDurably;
    const wrapped = async function () {
      durability('saving', '… جارٍ الحفظ'); emit('anas:durability-saving');
      try {
        const result = await original.apply(this, arguments);
        if (result === true) {
          const committed = syncLiveDurabilityStatusBar();
          emit(committed ? 'anas:durability-committed' : 'anas:durability-uncommitted');
        } else {
          durability('uncommitted', '⚠ لم يكتمل الحفظ'); emit('anas:durability-uncommitted');
        }
        return result;
      } catch (error) {
        durability('uncommitted', '⚠ فشل الحفظ');
        emit('anas:durability-failed', { message: String(error && error.message || error) });
        throw error;
      }
    };
    wrapped.__anasR40Wrapped = true; g.saveDBDurably = wrapped; return true;
  }
  syncBuildIdentity();
  if (g.document && g.document.addEventListener) g.document.addEventListener('DOMContentLoaded', syncBuildIdentity);
  network();
  g.addEventListener('online', function () { network(true); });
  g.addEventListener('offline', function () { network(false); });
  g.document.addEventListener('anas:storage-hydrated', function () {
    hookDurableSave(); syncLiveDurabilityStatusBar();
  });
  g.document.addEventListener('anas:storage-committed', syncLiveDurabilityStatusBar);
  g.document.addEventListener('anas:appdata-updated', syncLiveDurabilityStatusBar);
  g.document.addEventListener('anas:pos-cart-updated', syncLiveDurabilityStatusBar);
  hookDurableSave(); syncLiveDurabilityStatusBar();

  // Customer reconciliation: clientMovements is canonical. Invoices fill legacy missing
  // invoice_debit rows; only POSTED sale returns with linked financial movements count.
  function buildCustomerReconciliationRows(data,range,parseDate){
    const state=data&&typeof data==='object'?data:{};
    const customers=Array.isArray(state.customers)?state.customers:[];
    const invoices=Array.isArray(state.invoices)?state.invoices:[];
    const movements=Array.isArray(state.clientMovements)?state.clientMovements:[];
    const returns=Array.isArray(state.returns)?state.returns:[];
    const from=String(range&&range.from||''),to=String(range&&range.to||'');
    const centsField=value=>{
      if(typeof value==='bigint')return value;
      if(typeof value==='number'&&Number.isSafeInteger(value))return BigInt(value);
      const raw=String(value==null?'':value).trim();
      if(!/^[+-]?\d+$/.test(raw))return null;
      try{return BigInt(raw);}catch(_){return null;}
    };
    const moneyCents=value=>{
      const raw=String(value==null?'':value).trim().replace(',','.');
      const match=/^([+-]?)(\d+)(?:\.(\d{1,2}))?$/.exec(raw);
      if(!match)return null;
      const cents=BigInt(match[2])*100n+BigInt(((match[3]||'')+'00').slice(0,2));
      return match[1]==='-'?-cents:cents;
    };
    const dateOf=row=>reportRecordDate(row);
    const dayOf=row=>{
      const raw=dateOf(row),parsed=typeof parseDate==='function'?parseDate(raw):(raw?new Date(raw):null);
      if(!parsed||Number.isNaN(parsed.getTime()))return null;
      return parsed.getFullYear()+'-'+String(parsed.getMonth()+1).padStart(2,'0')+'-'+String(parsed.getDate()).padStart(2,'0');
    };
    const inRange=row=>{const day=dayOf(row);if(!day)return !from&&!to;return(!from||day>=from)&&(!to||day<=to);};
    const cancelled=invoice=>!!(invoice&&(invoice.cancelled||invoice.isCancelled||invoice.reversed||
      ['cancelled','canceled','void','voided'].includes(String(invoice.status||'').toLowerCase())));
    const invoiceId=invoice=>String((invoice&&(invoice.id??invoice.invoiceId))??'');
    const invoiceClientId=invoice=>String((invoice&&(invoice.customerId??invoice.clientId??invoice.customer?.id??invoice.client?.id))??'');
    const invoiceById=new Map(invoices.map(invoice=>[invoiceId(invoice),invoice]).filter(([id])=>id));
    const postedReturns=returns.filter(row=>row&&row.status==='POSTED'&&row.originalInvoiceType==='sales_invoice'&&
      ['SALE_RETURN','INVOICE_CANCEL'].includes(row.returnType));
    const returnById=new Map(postedReturns.map(row=>[String(row.returnId??row.id??''),row]).filter(([id])=>id));
    const customerById=new Map(customers.map(customer=>[String((customer&&customer.id)??''),customer]));
    const ids=new Set(customers.map(customer=>String((customer&&customer.id)??'')).filter(Boolean));
    movements.forEach(row=>{if(row&&row.clientId!=null)ids.add(String(row.clientId));});
    invoices.forEach(row=>{const id=invoiceClientId(row);if(id)ids.add(id);});
    const totals=new Map(),ensure=id=>{if(!totals.has(id))totals.set(id,{opening:0n,debit:0n,credit:0n,invalid:0,missingDate:0});return totals.get(id);};
    const invoiceDebitIds=new Set();
    const movementCents=row=>{
      if(row&&row.amountCentimes!=null)return centsField(row.amountCentimes);
      if(row&&row.amount_cents!=null)return centsField(row.amount_cents);
      return moneyCents(row&&row.amount);
    };
    const signedAmount=row=>{
      const amount=movementCents(row);if(amount===null)return null;
      const direction=row&&row.direction||(row&&['receipt','return_credit'].includes(row.type)?'credit':'debit');
      if(direction!=='debit'&&direction!=='credit')return null;
      return direction==='credit'?-amount:amount;
    };
    const allocationInvoiceId=allocation=>String((allocation&&
      (allocation.invoiceId??allocation.refId??allocation.referenceId??allocation.invoice_id))??'');
    const allocationAmount=allocation=>{
      if(!allocation||typeof allocation!=='object')return null;
      if(allocation.amountCentimes!=null)return centsField(allocation.amountCentimes);
      if(allocation.amount_cents!=null)return centsField(allocation.amount_cents);
      if(allocation.amountCents!=null)return centsField(allocation.amountCents);
      return moneyCents(allocation.amount);
    };
    const invoiceTotalCentsOf=invoice=>invoice&&invoice.totalCentimes!=null?centsField(invoice.totalCentimes):
      invoice&&invoice.total_cents!=null?centsField(invoice.total_cents):moneyCents(invoice&&invoice.total);
    const invoicePaidCentsOf=invoice=>invoice&&invoice.paidCentimes!=null?centsField(invoice.paidCentimes):
      invoice&&invoice.paid_cents!=null?centsField(invoice.paid_cents):moneyCents(invoice?(invoice.paid??0):0);
    const cashMovements=Array.isArray(state.cashMovements)?state.cashMovements:[];
    const cashById=new Map();
    for(const row of cashMovements){
      const cashId=row&&(row.id??row.movementId);
      if(cashId!=null&&String(cashId))cashById.set(String(cashId),row);
    }
    const saleAllocationsByInvoice=new Map(),seenSaleAllocationIds=new Set();
    for(const allocation of (Array.isArray(state.settlementAllocations)?state.settlementAllocations:[])){
      if(!allocation||allocation.partyType!=='customer'||allocation.invoiceType!=='sales_invoice'||
        allocation.sourceMovementType!=='sales_invoice')continue;
      const ref=allocationInvoiceId(allocation),clientId=String(allocation.partyId??'');
      if(!ref||!clientId)continue;
      const invoice=invoiceById.get(ref),sourceId=String(allocation.sourceMovementId??'');
      const sourceCash=cashById.get(sourceId),amount=allocationAmount(allocation);
      const sourceAmount=sourceCash?moneyCents(sourceCash.amount):null;
      if(!invoice||cancelled(invoice)||invoiceClientId(invoice)!==clientId||
        !sourceId||!sourceCash||sourceCash.type!=='add'||
        String(sourceCash.referenceType||'')!=='sales_invoice'||String(sourceCash.referenceId||'')!==ref||
        amount===null||amount<=0n||sourceAmount===null||sourceAmount!==amount){
        ensure(clientId).invalid++;continue;
      }
      const key=String(allocation.allocationId??'')||
        [sourceId,ref,String(allocation.amountCentimes??allocation.amount_cents??allocation.amount??'')].join('|');
      if(seenSaleAllocationIds.has(key))continue;
      seenSaleAllocationIds.add(key);
      const entry=saleAllocationsByInvoice.get(ref)||{clientId,totalCents:0n,rows:[],valid:false};
      entry.totalCents+=amount;entry.rows.push({allocation,amount,sourceId,sourceCash});
      saleAllocationsByInvoice.set(ref,entry);
    }
    for(const [ref,entry] of saleAllocationsByInvoice){
      const invoice=invoiceById.get(ref),total=invoiceTotalCentsOf(invoice),paid=invoicePaidCentsOf(invoice);
      if(!invoice||total===null||total<=0n||paid===null||entry.totalCents!==paid||entry.totalCents>total){
        ensure(entry.clientId).invalid++;entry.valid=false;continue;
      }
      entry.valid=true;
    }
    for(const movement of movements){
      if(!movement||movement.clientId==null)continue;
      const id=String(movement.clientId),type=String(movement.type||'');
      if(!['opening_balance','invoice_debit','receipt','return_credit','adjustment'].includes(type))continue;
      if(type==='invoice_debit'){
        const linkedInvoice=invoiceById.get(String(movement.referenceId||movement.invoiceId||movement.refId||''));
        if(linkedInvoice&&cancelled(linkedInvoice))continue;
        const debitRef=movement.referenceId??movement.invoiceId??movement.refId;if(debitRef!=null)invoiceDebitIds.add(String(debitRef));
      }
      if(type==='return_credit'){
        const posted=returnById.get(String(movement.referenceId||movement.refId||''));if(!posted)continue;
        const linkedInvoice=invoiceById.get(String(posted.originalInvoiceId||''));
        if(!linkedInvoice||cancelled(linkedInvoice)||invoiceClientId(linkedInvoice)!==id)continue;
        const linkedIds=Array.isArray(posted.financialMovementIds)?posted.financialMovementIds.map(String):[];
        const movementId=String(movement.movementId||movement.id||'');
        if(!movementId||!linkedIds.includes(movementId))continue;
      }
      let amount=signedAmount(movement);
      const target=ensure(id);
      if(type==='invoice_debit'){
        const ref=String(movement.referenceId||movement.invoiceId||movement.refId||'');
        const saleInfo=saleAllocationsByInvoice.get(ref);
        if(saleInfo&&saleInfo.valid){
          const gross=invoiceTotalCentsOf(invoiceById.get(ref));
          if(gross===null||gross<=0n){target.invalid++;continue;}
          amount=gross;
        }
      }
      if(amount===null){target.invalid++;continue;}
      const day=dayOf(movement);if(!day&&(from||to)){target.missingDate++;continue;}
      if(from&&day&&day<from){target.opening+=amount;continue;}
      if(inRange(movement)){if(amount>0n)target.debit+=amount;else if(amount<0n)target.credit+=-amount;}
    }
    for(const [ref,entry] of saleAllocationsByInvoice){
      if(!entry.valid)continue;
      const target=ensure(entry.clientId);
      for(const row of entry.rows){
        const alreadyInClientLedger=movements.some(movement=>{
          if(!movement||movement.type!=='receipt')return false;
          const movementId=String(movement.movementId||movement.id||'');
          return movementId===row.sourceId||movementId==='CL-REC-'+row.sourceId;
        });
        if(alreadyInClientLedger)continue;
        const dateRecord={date:row.sourceCash.date,createdAt:row.allocation.createdAt};
        const day=dayOf(dateRecord);
        if(!day&&(from||to)){target.missingDate++;continue;}
        if(from&&day&&day<from){target.opening-=row.amount;continue;}
        if(inRange(dateRecord))target.credit+=row.amount;
      }
    }
    // Legacy invoice fallback: reconstruct only the original receivable, never the mutable
    // remaining balance. Subsequent credits stay in clientMovements at their real dates.
    const linkedCreditsForInvoice=(invoice,clientId)=>{
      const ref=invoiceId(invoice),seen=new Set();let sum=0n;
      // ANAS customer-debt receipts are stored once in clientMovements and apportioned
      // per invoice in settlementAllocations. Match the allocation to its real receipt.
      const settlementAllocations=Array.isArray(state.settlementAllocations)?state.settlementAllocations:[];
      const seenAllocations=new Set();
      for(const allocation of settlementAllocations){
        if(!allocation||allocation.partyType!=='customer'||String(allocation.partyId??'')!==clientId||
          allocation.invoiceType!=='sales_invoice'||String(allocation.invoiceId??'')!==ref||
          allocation.sourceMovementType!=='customer_debt')continue;
        const sourceId=String(allocation.sourceMovementId??'');
        if(!sourceId)continue;
        const source=movements.find(movement=>{
          if(!movement||String(movement.clientId??'')!==clientId||movement.type!=='receipt')return false;
          const movementId=String(movement.movementId||movement.id||'');
          return movementId===sourceId||movementId==='CL-REC-'+sourceId||String(movement.id??'')===sourceId;
        });
        if(!source)continue;
        const allocationKey=String(allocation.allocationId??'')||
          [sourceId,ref,String(allocation.amountCentimes??allocation.amount_cents??allocation.amount??'')].join('|');
        if(seenAllocations.has(allocationKey))continue;
        const allocated=allocationAmount(allocation);
        if(allocated===null||allocated<=0n)continue;
        seenAllocations.add(allocationKey);
        const sourceKey=String(source.movementId||source.id||'');
        if(sourceKey)seen.add(sourceKey);
        sum+=allocated;
      }
      for(const movement of movements){
        if(!movement||String(movement.clientId??'')!==clientId)continue;
        const signed=signedAmount(movement);if(signed===null||signed>=0n)continue;
        const type=String(movement.type||'');
        if(!['receipt','return_credit','adjustment'].includes(type))continue;
        if(type==='return_credit'){
          const posted=returnById.get(String(movement.referenceId||movement.refId||''));
          if(!posted||String(posted.originalInvoiceId||'')!==ref)continue;
          const linkedIds=Array.isArray(posted.financialMovementIds)?posted.financialMovementIds.map(String):[];
          const movementId=String(movement.movementId||movement.id||'');
          if(!movementId||!linkedIds.includes(movementId))continue;
          if(seen.has(movementId))continue;
          // A validated POSTED return links through its return record, not through
          // movement.referenceId (which is the return ID rather than the invoice ID).
          sum+=-signed;seen.add(movementId);continue;
        }
        const movementKey=String(movement.movementId||movement.id||'');
        if(movementKey&&seen.has(movementKey))continue;
        const allocations=Array.isArray(movement.allocations)?movement.allocations:null;
        let linked=0n;
        if(allocations&&allocations.length){
          for(const allocation of allocations){
            if(allocationInvoiceId(allocation)!==ref)continue;
            const allocated=allocationAmount(allocation);
            if(allocated!==null&&allocated>0n)linked+=allocated;
          }
        }else{
          const direct=[movement.invoiceId,movement.invoice_id,movement.refId].some(value=>value!=null&&String(value)===ref)||
            (String(movement.referenceType||'').toLowerCase().includes('invoice')&&
              movement.referenceId!=null&&String(movement.referenceId)===ref);
          if(direct)linked=-signed;
        }
        if(linked>0n){sum+=linked;if(movementKey)seen.add(movementKey);}
      }
      return sum;
    };
    for(const invoice of invoices){
      if(!invoice||cancelled(invoice))continue;
      const id=invoiceClientId(invoice),ref=invoiceId(invoice);
      if(!id||!ref||invoiceDebitIds.has(ref))continue;
      const invoiceTotalCents=invoiceTotalCentsOf(invoice);
      const invoicePaidCents=invoicePaidCentsOf(invoice);
      if(invoiceTotalCents===null||invoiceTotalCents<=0n)continue;
      const paid=invoicePaidCents!==null&&invoicePaidCents>0n?invoicePaidCents:0n;
      const linkedMovementCreditsCents=linkedCreditsForInvoice(invoice,id);
      // Verified immediate sale allocations are gross-invoice credits. Legacy invoices
      // without a linked source cash movement retain the conservative net fallback.
      const saleInfo=saleAllocationsByInvoice.get(ref);
      const explicitInitialPaid=saleInfo&&saleInfo.valid?saleInfo.totalCents:null;
      const untrackedInitialPaidCents=explicitInitialPaid!==null?explicitInitialPaid:
        (paid>linkedMovementCreditsCents?paid-linkedMovementCreditsCents:0n);
      const initialPaidCents=untrackedInitialPaidCents>invoiceTotalCents?
        invoiceTotalCents:untrackedInitialPaidCents;
      const originalReceivableCents=explicitInitialPaid!==null?
        invoiceTotalCents:invoiceTotalCents-initialPaidCents;
      if(originalReceivableCents<=0n)continue;
      const target=ensure(id),day=dayOf(invoice);
      if(!day&&(from||to)){target.missingDate++;continue;}
      if(from&&day&&day<from){target.opening+=originalReceivableCents;continue;}
      if(inRange(invoice))target.debit+=originalReceivableCents;
    }
    const format=cents=>{
      const abs=cents<0n?-cents:cents;
      return(cents<0n?'−':'')+(abs/100n).toLocaleString('fr-DZ')+','+(abs%100n).toString().padStart(2,'0')+' د.ج';
    };
    return[...ids].sort((a,b)=>a.localeCompare(b)).map(id=>{
      const customer=customerById.get(id),target=ensure(id);
      const name=String(customer&&customer.name||movements.find(m=>String(m.clientId)===id)?.clientName||'عميل غير مسمى');
      const closing=target.opening+target.debit-target.credit;
      return{customerId:id,openingBalanceCents:target.opening,periodDebitCents:target.debit,periodCreditCents:target.credit,
        closingBalanceCents:closing,invalidRows:target.invalid,missingDateRows:target.missingDate,
        cells:[name,String(customer&&(customer.phone||customer.mobile)||id),format(target.opening),format(target.debit),
          format(target.credit),format(closing),'بانتظار المطابقة — توقيع/ختم العميل: __________________']};
    });
  }
  function renderCustomerReconciliationReport(title){
    if(typeof g.applyReportDateRange==='function'&&!g.applyReportDateRange())return;
    const data=g.AppData||{},range=typeof g.getReportRange==='function'?g.getReportRange():{from:'',to:''};
    const rows=buildCustomerReconciliationRows(data,range,g.reportParseDate);
    const escape=value=>String(value==null?'':value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    const headers=['اسم العميل','الهاتف/المعرف','رصيد أول الفترة','إجمالي المسحوبات (مدين)',
      'إجمالي المدفوعات والمرتجعات (دائن)','الرصيد الختامي المستحق للمصادقة','حالة المطابقة وإقرار المصادقة'];
    const body=rows.map(row=>'<tr data-customer-id="'+escape(row.customerId)+'">'+row.cells.map(cell=>'<td>'+escape(cell)+'</td>').join('')+'</tr>').join('');
    const content=g.document&&g.document.getElementById('customReportContent');
    const titleNode=g.document&&g.document.getElementById('customReportTitle');
    const modal=g.document&&g.document.getElementById('customReportModal');
    if(!content||!titleNode||!modal)return;
    titleNode.textContent=title;
    content.innerHTML='<div class="anas-customer-reconciliation-report">'+
      '<p class="anas-report-source-note">مصدر البيانات: AppData.customers + AppData.invoices + AppData.clientMovements + AppData.cashMovements + AppData.settlementAllocations + AppData.returns</p>'+
      '<div style="overflow:auto;max-width:100%"><table><thead><tr>'+headers.map(header=>'<th>'+escape(header)+'</th>').join('')+
      '</tr></thead><tbody>'+body+'</tbody></table></div>'+
      '<p class="anas-report-integrity-note">الحساب بالسنتيم باستخدام BigInt. لا تُدرج المرتجعات إلا إذا كانت POSTED ومرتبطة بحركة دفتر العميل.</p></div>';
    const invalid=rows.reduce((sum,row)=>sum+row.invalidRows+row.missingDateRows,0);
    if(invalid&&typeof content.insertAdjacentHTML==='function')content.insertAdjacentHTML('afterbegin',
      '<p class="anas-report-integrity-warning">سجلات مستبعدة للمراجعة: '+invalid+' (مبالغ غير صالحة أو تواريخ غير متاحة ضمن الفترة).</p>');
    modal.classList.add('active');
    const search=g.document.getElementById('anasReportSearch');if(search)search.value='';
    if(typeof g.anasFilterCurrentReport==='function')g.anasFilterCurrentReport('');
    return rows;
  }
  g.anasBuildCustomerReconciliationRows=buildCustomerReconciliationRows;
  // Report handlers are composed once below, after both report renderers exist.



  // r46: normalized report date extraction and store movement report modal.
  function normalizeReportDateValue(value) {
    if(value==null||value==='')return null;
    if(value instanceof Date)return Number.isNaN(value.getTime())?null:value;
    if(typeof value==='number'&&Number.isFinite(value)){const d=new Date(value);return Number.isNaN(d.getTime())?null:d;}
    const raw=String(value).trim().replace(/[٠-٩]/g,ch=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(ch))).replace(/[۰-۹]/g,ch=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(ch)));
    if(/^\d{12,}$/.test(raw)){const d=new Date(Number(raw));return Number.isNaN(d.getTime())?null:d;}
    const part=raw.replace(/[,،].*$/,'').replace(/[T\s].*$/,'').trim();
    let m=/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(part),y,mo,day;
    if(m){y=+m[1];mo=+m[2];day=+m[3];}else{m=/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(part);if(!m)return null;day=+m[1];mo=+m[2];y=+m[3];}
    const d=new Date(y,mo-1,day);return y>=1000&&d.getFullYear()===y&&d.getMonth()===mo-1&&d.getDate()===day?d:null;
  }
  function reportRecordDate(row){
    if(!row||typeof row!=='object')return null;
    // Skip malformed preferred fields instead of hiding a valid invoiceDate/createdAt.
    // Every candidate is validated by the same strict parser used by the report filters.
    for(const k of ['date','invoiceDate','createdAt','timestamp','time','day','created_at','invoice_date','updatedAt','updated_at']){
      const candidate=row[k];
      if(candidate===undefined||candidate===null||candidate==='')continue;
      if(normalizeReportDateValue(candidate))return candidate;
    }
    const m=/(?:^|\D)(20\d{2})[-_/]?(\d{2})[-_/]?(\d{2})(?:\D|$)/.exec(String(row.id||row.invoiceId||''));
    if(!m)return null;
    const fromId=m[1]+'-'+m[2]+'-'+m[3];
    return normalizeReportDateValue(fromId)?fromId:null;
  }
  g.anasNormalizeReportDateValue=normalizeReportDateValue;g.anasGetReportRecordDate=reportRecordDate;
  if(typeof g.reportParseDate==='function'&&!g.reportParseDate.__anasR46){
    const parser=value=>{const d=normalizeReportDateValue(value);return d?new Date(d.getFullYear(),d.getMonth(),d.getDate()):null;};
    parser.__anasR46=true;g.reportParseDate=parser;
  }
  function renderStoreMovementReport(chartMode){
    if(typeof g.applyReportDateRange==='function'&&!g.applyReportDateRange())return false;
    const data=g.AppData||{},range=typeof g.getReportRange==='function'?g.getReportRange():{from:'',to:''};
    const arr=k=>Array.isArray(data[k])?data[k]:[];
    const inside=row=>{const d=normalizeReportDateValue(reportRecordDate(row));if(!d)return !range.from&&!range.to;const day=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');return(!range.from||day>=range.from)&&(!range.to||day<=range.to);};
    const val=(r,keys)=>{for(const k of keys){const n=Number(r&&r[k]);if(Number.isFinite(n))return n;}return 0;};
    const sales=arr('invoices').filter(r=>inside(r)&&!(r.cancelled||r.isCancelled||r.reversed||/cancel|void/i.test(String(r.status||''))));
    const purchases=arr('purchases').filter(inside),expenses=arr('expenses').filter(inside);
    const postedReturns=arr('returns').filter(r=>inside(r)&&r&&r.status==='POSTED'&&r.originalInvoiceType==='sales_invoice');
    const returnedTotal=postedReturns.reduce((s,r)=>s+val(r,['total','returnTotal','refundAmount','amount']),0);
    const cash=sales.reduce((s,r)=>s+val(r,['cashPaid','cash','paid','paidAmount']),0);
    const credit=sales.reduce((s,r)=>s+Math.max(0,val(r,['debt','remaining','remainingAmount','due'])),0);
    const metrics=[['صافي المبيعات',sales.reduce((s,r)=>s+val(r,['total','grandTotal','amount']),0)-returnedTotal],['النقد',cash],['الآجل',credit],
      ['المشتريات',purchases.reduce((s,r)=>s+val(r,['total','grandTotal','amount']),0)],
      ['المصروفات',expenses.reduce((s,r)=>s+val(r,['amount','total','value']),0)],
      ['رصيد الصندوق',Number(data.cashBalance??data.cashboxBalance??data.cash??(cash-expenses.reduce((s,r)=>s+val(r,['amount','total','value']),0)))||0]];
    const fmt=n=>(Number(n)||0).toLocaleString('fr-DZ',{minimumFractionDigits:2,maximumFractionDigits:2})+' د.ج';
    const esc=v=>String(v??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    const title=g.document.getElementById('customReportTitle'),content=g.document.getElementById('customReportContent'),modal=g.document.getElementById('customReportModal');
    if(!title||!content||!modal)return false;
    const max=Math.max(1,...metrics.map(m=>Math.abs(m[1])));
    const chart=chartMode?'<svg viewBox="0 0 640 220" role="img" aria-label="مخطط حركة المتجر" style="width:100%;height:auto"><line x1="18" y1="178" x2="622" y2="178" stroke="#94a3b8"/>'+metrics.map((m,i)=>{const h=Math.max(3,Math.abs(m[1])/max*132),x=32+i*99;return '<rect x="'+x+'" y="'+(176-h)+'" width="54" height="'+h+'" rx="5" fill="#1d4ed8"/><text x="'+(x+27)+'" y="202" text-anchor="middle" font-size="10" fill="currentColor">'+esc(m[0])+'</text>';}).join('')+'</svg>':'';
    const invoices=sales.map(r=>[r.id||r.invoiceId||'',reportRecordDate(r)||'',val(r,['total','grandTotal','amount']),val(r,['paid','paidAmount','cashPaid']),Math.max(0,val(r,['debt','remaining','remainingAmount','due']))]);
    const table='<div style="overflow:auto"><table style="width:100%;min-width:520px;border-collapse:collapse"><thead><tr>'+['رقم الفاتورة','التاريخ','الإجمالي','المدفوع','المتبقي'].map(x=>'<th style="padding:8px;background:#e2e8f0;color:#0f172a">'+x+'</th>').join('')+'</tr></thead><tbody>'+invoices.map(row=>'<tr>'+row.map(x=>'<td style="padding:7px;border-bottom:1px solid #cbd5e1">'+esc(x)+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';
    title.textContent=chartMode?'حركة المتجر - رسم بياني':'حركة المتجر';
    content.innerHTML='<div class="anas-store-movement-report"><div class="anas-store-movement-kpis">'+metrics.map(m=>'<div class="anas-store-kpi"><span>'+m[0]+'</span><strong>'+fmt(m[1])+'</strong></div>').join('')+'</div>'+chart+table+'<div class="anas-store-report-actions"><button type="button" data-store-print>طباعة التقرير</button><button type="button" data-store-csv>تصدير CSV</button></div></div>';
    modal.classList.add('active');
    content.querySelector('[data-store-print]').addEventListener('click',()=>{const w=g.open('','_blank');if(!w)return;w.document.write('<!doctype html><html dir="rtl"><meta charset="utf-8"><body>'+content.innerHTML+'</body></html>');w.document.close();w.print();});
    content.querySelector('[data-store-csv]').addEventListener('click',()=>{const csv=[['رقم الفاتورة','التاريخ','الإجمالي','المدفوع','المتبقي'],...invoices].map(r=>r.map(v=>'"'+String(v??'').replace(/"/g,'""')+'"').join(',')).join('\r\n');const url=URL.createObjectURL(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'}));const a=g.document.createElement('a');a.href=url;a.download='store-movement-report.csv';a.click();URL.revokeObjectURL(url);});
    return true;
  }
  function hookShowReportDetails(){
    const current=g.showReportDetails;
    if(typeof current!=='function'||current.__anasHooked)return false;
    const original=current;
    const wrapped=function(title){
      scheduleDomRepairs();
      if(title==='تقرير مصادقة حساب العميل'||title==='مصادقة حساب العميل')return renderCustomerReconciliationReport(title);
      if(title==='حركة المتجر'||title==='حركة المتجر - رسم بياني')return renderStoreMovementReport(title.includes('رسم بياني'));
      const result=original.apply(this,arguments);
      scheduleDomRepairs();
      return result;
    };
    wrapped.__anasHooked=true;
    g.showReportDetails=wrapped;
    return true;
  }

  function installInquiryTabs(){
    const list=g.document.getElementById('anasQueriesList');if(!list||list.dataset.anasTabsReady)return;
    const groups=Array.from(list.querySelectorAll(':scope > .anas-query-group'));if(!groups.length)return;
    const tabs=[['all','الكل'],['store','المتجر'],['sales','المبيعات'],['customers','العملاء'],['purchases','المشتريات'],['suppliers','الموردون'],['cash','الصندوق'],['expenses','المصروفات'],['warehouse','المخازن']];
    const bar=g.document.createElement('div');bar.className='anas-inquiry-filter-tabs';bar.setAttribute('role','tablist');bar.setAttribute('aria-label','تصفية أقسام الاستعلامات');
    tabs.forEach(([key,label],i)=>{const b=g.document.createElement('button');b.type='button';b.textContent=label;b.dataset.filter=key;b.setAttribute('role','tab');b.setAttribute('aria-selected',i===0?'true':'false');if(i===0)b.classList.add('active');b.addEventListener('click',()=>{bar.querySelectorAll('button').forEach(x=>{const active=x===b;x.classList.toggle('active',active);x.setAttribute('aria-selected',active?'true':'false');});groups.forEach(group=>{const h=group.querySelector('.anas-query-group-heading')?.textContent.trim()||'';const wanted={store:'المتجر',sales:'المبيعات',customers:'العملاء',purchases:'المشتريات',suppliers:'الموردين',cash:'الصندوق',expenses:'المصروفات',warehouse:'المخازن'}[key];group.hidden=key!=='all'&&h!==wanted;});});bar.appendChild(b);});
    list.parentNode.insertBefore(bar,list);list.dataset.anasTabsReady='1';
  }
  function compactCustomerActions(){
    const view=g.document.getElementById('view-customers');if(!view)return;
    const cards=Array.from(view.querySelectorAll('.action-menu-list .menu-action-card'));
    cards.forEach(card=>{const t=card.textContent.replace(/\s+/g,' ').trim();if(/ذمم العملاء\s*[-—].*تقرير|العملاء المتبقي لهم أرصدة|فحص ارصدة العملاء|فحص أرصدة العملاء/i.test(t))card.hidden=true;});
    const directory=cards.find(card=>/عرض وإدارة العملاء/.test(card.textContent));
    if(directory&&!directory.dataset.anasSmoothBound){directory.addEventListener('click',()=>g.setTimeout(()=>g.document.querySelector('#customerDirectoryList')?.closest('.card')?.scrollIntoView({behavior:'smooth',block:'start'}),90));directory.dataset.anasSmoothBound='1';}
  }
  function normalizeInvoiceCurrency(){
    const root=g.document.getElementById('invoicesList')||g.document.getElementById('view-invoices-list');if(!root)return;
    root.querySelectorAll('*').forEach(el=>{
      if(el.children.length||el.dataset.anasNormalized==='1')return;
      const text=el.textContent||'';
      if(/\bDA\b/.test(text)){el.textContent=text.replace(/\bDA\b/g,'د.ج');el.dataset.anasNormalized='1';}
    });
  }
  function restoreAiPdfUploadCard(){
    const view=g.document.getElementById('view-ai-excel-hub');
    if(!view)return false;
    const card=view.querySelector('label.anas-ai-document-card[data-anas-ai-action="pdf"]');
    if(!card)return false;
    card.hidden=false;
    card.removeAttribute('hidden');
    card.style.setProperty('display','flex','important');
    card.style.setProperty('visibility','visible','important');
    card.style.setProperty('opacity','1','important');
    card.style.setProperty('pointer-events','auto','important');
    return true;
  }
  function applyR46DomRepairs(){
    installInquiryTabs();compactCustomerActions();normalizeInvoiceCurrency();restoreAiPdfUploadCard();
    const badge=g.document.getElementById('anas-status-version-badge'),bar=g.document.getElementById('anas-live-status-bar');
    syncBuildIdentity();
    const trucks=g.document.getElementById('view-trucks');
    if(trucks)trucks.querySelectorAll('button').forEach(b=>{const t=b.textContent.trim();if(t==='إضافة'||t==='حفظ الرحلة')b.classList.add('anas-truck-primary-action');});
    const purchases=g.document.getElementById('view-purchases');
    if(purchases)purchases.querySelectorAll('button').forEach(b=>{if(b.textContent.trim()==='مسح الكل')b.classList.add('anas-purchase-clear-action');});
  }
  let repairTimer=null;
  function scheduleDomRepairs(){
    if(typeof g.setTimeout!=='function'){applyR46DomRepairs();return;}
    if(repairTimer!==null&&typeof g.clearTimeout==='function')g.clearTimeout(repairTimer);
    repairTimer=g.setTimeout(()=>{repairTimer=null;applyR46DomRepairs();},50);
  }
  function hookOpenView(){
    const current=g.openView;
    if(typeof current!=='function'||current.__anasHooked)return false;
    const original=current;
    const wrapped=function(){
      const result=original.apply(this,arguments);
      scheduleDomRepairs();
      return result;
    };
    wrapped.__anasHooked=true;
    g.openView=wrapped;
    return true;
  }
  function installNavigationHooks(){hookOpenView();hookShowReportDetails();}
  if(g.document.readyState==='loading'){
    g.document.addEventListener('DOMContentLoaded',function(){installNavigationHooks();scheduleDomRepairs();},{once:true});
  }else{installNavigationHooks();scheduleDomRepairs();}

})(window);
