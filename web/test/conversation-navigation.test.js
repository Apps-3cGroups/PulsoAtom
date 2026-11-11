import test from 'node:test';
import assert from 'node:assert/strict';
import {conversationLink,conversationReturn} from '../src/services/conversationNavigation.js';
test('detail return URL preserves multicountry, empty figures, period and active page after a reload',()=>{
 for(const source of ['/?days=30&countries=HN,PA&figures=&variable=cliente_molesto&pending=1','/activas?countries=HN,PA&page=2']){
  const detail=new URL(conversationLink('chat 1',source),'https://pulso.invalid');
  assert.equal(conversationReturn(detail.searchParams).to,source);
  detail.searchParams.set('metricDate','2026-11-10');assert.equal(conversationReturn(detail.searchParams).to,source);
 }
 assert.equal(conversationReturn(new URLSearchParams()).to,'/historico');
 assert.equal(conversationReturn(new URLSearchParams({returnTo:'https://example.com'})).to,'/historico');
});
