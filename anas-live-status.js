(function (g) {
  'use strict';
  if (g.__ANAS_LIVE_DURABILITY_STATUS_R40__) return;
  g.__ANAS_LIVE_DURABILITY_STATUS_R40__ = true;
  function bar() { return g.document && g.document.getElementById('anas-live-status-bar'); }
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
    const dateOf=row=>row&&(row.createdAt||row.date||row.timestamp||row.invoiceDate||row.created_at);
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
      const amount=signedAmount(movement),target=ensure(id);
      if(amount===null){target.invalid++;continue;}
      const day=dayOf(movement);if(!day&&(from||to)){target.missingDate++;continue;}
      if(from&&day&&day<from){target.opening+=amount;continue;}
      if(inRange(movement)){if(amount>0n)target.debit+=amount;else if(amount<0n)target.credit+=-amount;}
    }
    // Legacy invoice fallback: reconstruct only the original receivable, never the mutable
    // remaining balance. Subsequent credits stay in clientMovements at their real dates.
    const allocationInvoiceId=allocation=>String((allocation&&
      (allocation.invoiceId??allocation.refId??allocation.referenceId??allocation.invoice_id))??'');
    const allocationAmount=allocation=>{
      if(!allocation||typeof allocation!=='object')return null;
      if(allocation.amountCentimes!=null)return centsField(allocation.amountCentimes);
      if(allocation.amount_cents!=null)return centsField(allocation.amount_cents);
      if(allocation.amountCents!=null)return centsField(allocation.amountCents);
      return moneyCents(allocation.amount);
    };
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
      const invoiceTotalCents=invoice.totalCentimes!=null?centsField(invoice.totalCentimes):
        invoice.total_cents!=null?centsField(invoice.total_cents):moneyCents(invoice.total);
      const invoicePaidCents=invoice.paidCentimes!=null?centsField(invoice.paidCentimes):
        invoice.paid_cents!=null?centsField(invoice.paid_cents):moneyCents(invoice.paid??0);
      if(invoiceTotalCents===null||invoiceTotalCents<=0n)continue;
      const paid=invoicePaidCents!==null&&invoicePaidCents>0n?invoicePaidCents:0n;
      const linkedMovementCreditsCents=linkedCreditsForInvoice(invoice,id);
      // Current POS persists the immediate sale payment as a sales_invoice allocation.
      // Prefer this explicit origin amount; old imported invoices without it use the
      // cumulative paid minus invoice-linked client-ledger credits reconstruction.
      let hasInitialSaleAllocation=false,initialSalePaidCents=0n;
      const saleAllocations=Array.isArray(state.settlementAllocations)?state.settlementAllocations:[];
      const seenSaleAllocations=new Set();
      for(const allocation of saleAllocations){
        if(!allocation||allocation.partyType!=='customer'||String(allocation.partyId??'')!==id||
          allocation.invoiceType!=='sales_invoice'||String(allocation.invoiceId??'')!==ref||
          allocation.sourceMovementType!=='sales_invoice')continue;
        const key=String(allocation.allocationId??'')||
          [String(allocation.sourceMovementId??''),ref,String(allocation.amountCentimes??allocation.amount_cents??allocation.amount??'')].join('|');
        if(seenSaleAllocations.has(key))continue;
        const amount=allocationAmount(allocation);
        if(amount===null||amount<0n)continue;
        seenSaleAllocations.add(key);hasInitialSaleAllocation=true;initialSalePaidCents+=amount;
      }
      const untrackedInitialPaidCents=hasInitialSaleAllocation?initialSalePaidCents:
        (paid>linkedMovementCreditsCents?paid-linkedMovementCreditsCents:0n);
      const initialPaidCents=untrackedInitialPaidCents>invoiceTotalCents?
        invoiceTotalCents:untrackedInitialPaidCents;
      const originalReceivableCents=invoiceTotalCents-initialPaidCents;
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
      '<p class="anas-report-source-note">مصدر البيانات: AppData.customers + AppData.invoices + AppData.clientMovements + AppData.returns</p>'+
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
  const originalShowReportDetails=g.showReportDetails;
  if(typeof originalShowReportDetails==='function'&&!originalShowReportDetails.__anasCustomerReconciliationWrapped){
    const wrappedShowReportDetails=function(title){
      if(title==='تقرير مصادقة حساب العميل'||title==='مصادقة حساب العميل')return renderCustomerReconciliationReport(title);
      return originalShowReportDetails.apply(this,arguments);
    };
    wrappedShowReportDetails.__anasCustomerReconciliationWrapped=true;
    g.showReportDetails=wrappedShowReportDetails;
  }

})(window);
