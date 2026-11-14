'use strict';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';

const ROOT=process.cwd();
const cartScript=path.join(ROOT,'anas-pos-floating-cart.js');
const statusScript=path.join(ROOT,'anas-live-status.js');
const cartCss=fs.readFileSync(path.join(ROOT,'anas-pos-floating-cart.css'),'utf8');
const html=fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
function inlineStyle(id){
  const match=new RegExp('<style id="'+id+'">([\\s\\S]*?)<\\/style>').exec(html);
  assert.ok(match,'missing inline style '+id);
  return match[1];
}

test('r40 unified mobile cart, exact fractional weights, tabular numerals and live durability in Chromium',async t=>{
  const browser=await chromium.launch({headless:true});
  t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:390,height:844}});
  assert.ok(html.includes('id="anas-live-status-bar"'));
  await page.setContent('<!doctype html><html><head><style>'+cartCss+'</style><style>'+inlineStyle('anas-r39-financial-numerals')+'</style></head><body>'+
    '<div id="anas-live-status-bar" data-network-state="online" data-durability-state="committed" data-build-version="r39"><span id="anas-status-network-badge"></span><span id="anas-status-durability-badge"></span><span id="anas-status-version-badge">r39</span></div>'+
    '<section id="view-pos" class="active"><div id="posItemsTableBody"></div></section>'+
    '<div class="erp-num" id="n1">12</div><div class="pos-qty" id="n2">.25</div><div class="balance-badge" id="n3">3</div><table><tr><td>label</td><td id="n4">4</td></tr></table><input id="n5" type="number" value="2"></body></html>');
  await page.evaluate(()=>{
    window.posCart=[{name:'وزن',price:'125.50',qty:'1',unit:'kg'}];
    window.setPosQty=(i,q)=>window.posCart[i].qty=q;
    window.removePosCartItem=i=>window.posCart.splice(i,1);
    window.anasCartTotalCents=rows=>rows.reduce((sum,item)=>{
      const qty=window.ANASPosExactQuantity.parseQtyToMillisBigInt(item.qty);
      const cents=BigInt(item.price.replace('.',''));
      return sum+(cents*qty+500n)/1000n;
    },0n);
    window.openHasibModal=()=>window.__checkout=true;
    window.renderPosTable=()=>document.dispatchEvent(new Event('anas:pos-cart-updated'));
  });
  await page.addScriptTag({path:cartScript});
  const exact=await page.evaluate(()=>{
    const q=window.ANASPosExactQuantity;
    const host=document.getElementById('anasPosFloatingCart');
    return {
      weights:['0.25','0.5','1','2','5','10'].map(x=>q.parseQtyToMillisBigInt(x).toString()),
      formatted:q.formatMillisToQtyString(250n),
      line:q.computeLineTotalCentimesBigInt(12550n,250n).toString(),
      chips:host.querySelectorAll('.anas-weight-chip').length,
      sticky:document.getElementById('anas-sticky-checkout-bar'),
      unified:host.classList.contains('anas-pos-unified-checkout')
    };
  });
  assert.deepEqual(exact.weights,['250','500','1000','2000','5000','10000']);
  assert.equal(exact.formatted,'0.25');
  assert.equal(exact.line,'3138');
  assert.equal(exact.chips,6);
  assert.equal(exact.sticky,null,'legacy duplicate sticky checkout must not be mounted');
  assert.equal(exact.unified,true);
  for(const width of [320,360,390]){
    await page.setViewportSize({width,height:844});
    const box=await page.evaluate(()=>{
      const host=document.getElementById('anasPosFloatingCart');
      const checkout=host.querySelector('[data-mini-action="checkout"]');
      const r=host.getBoundingClientRect(),b=checkout.getBoundingClientRect();
      return {
        visible:!host.hidden&&getComputedStyle(host).display!=='none',
        position:getComputedStyle(host).position,
        width:b.width,height:b.height,bottom:r.bottom,
        count:host.querySelector('[data-mini-cart-count]').textContent,
        total:host.querySelector('[data-mini-cart-total]').textContent
      };
    });
    assert.equal(box.visible,true);
    assert.equal(box.position,'fixed');
    assert.ok(box.width>=44&&box.height>=44);
    assert.ok(box.bottom<=844-60,'unified cart must stay above the bottom navigation');
    assert.equal(box.count,'1');
    assert.ok(box.total.includes('د.ج'));
  }
  await page.locator('#anasPosFloatingCart .anas-weight-chip').filter({hasText:'0.25'}).click();
  assert.equal(await page.evaluate(()=>window.posCart[0].qty),'0.25');
  await page.locator('#anasPosFloatingCart [data-mini-action="checkout"]').click();
  assert.equal(await page.evaluate(()=>window.__checkout),true);
  const numerals=await page.evaluate(()=>['n1','n2','n3','n4','n5'].map(id=>getComputedStyle(document.getElementById(id)).fontVariantNumeric));
  assert.deepEqual(numerals,['tabular-nums','tabular-nums','tabular-nums','tabular-nums','tabular-nums']);
  await page.evaluate(()=>{
    window.AppData={revision:1,balance:12n};window.__snap=window.AppData;
    window.ANASResilientStorage={getCommittedSnapshot:()=>window.__snap,canonicalizeJson:v=>JSON.stringify(v,(_,x)=>typeof x==='bigint'?{bigint:x.toString()}:x)};
    window.saveDBDurably=()=>new Promise(resolve=>window.__resolve=resolve);
  });
  await page.addScriptTag({path:statusScript});
  await page.evaluate(()=>dispatchEvent(new Event('offline')));
  assert.equal(await page.locator('#anas-live-status-bar').getAttribute('data-network-state'),'offline');
  await page.evaluate(()=>dispatchEvent(new Event('online')));
  assert.equal(await page.locator('#anas-live-status-bar').getAttribute('data-network-state'),'online');
  const during=await page.evaluate(async()=>{
    const pending=window.saveDBDurably();await Promise.resolve();
    const state=document.getElementById('anas-live-status-bar').dataset.durabilityState;
    window.__resolve(true);await pending;return state;
  });
  assert.equal(during,'saving');
  assert.equal(await page.locator('#anas-live-status-bar').getAttribute('data-durability-state'),'committed');
  await page.evaluate(()=>{window.AppData={revision:2,balance:99n};window.syncLiveDurabilityStatusBar();});
  assert.equal(await page.locator('#anas-live-status-bar').getAttribute('data-durability-state'),'uncommitted');
  assert.equal(await page.locator('#anas-status-version-badge').textContent(),'r39');
});
