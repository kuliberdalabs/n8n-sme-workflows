'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {executeCodeNode,loadWorkflow,workflowFile}=require('./helpers/workflow-vm');
const file=workflowFile('14-crm-invoicing-reconciliation');
const run=(name,input={},options={})=>{const result=executeCodeNode(file,name,{input,...options});return Array.isArray(result)?result[0]:result;};
const vars={RECON_CRM_TOKEN:'crm-synthetic-token-12345678',RECON_INVOICE_TOKEN:'invoice-synthetic-token-12345678',RECON_CRM_BASE_URL:'https://crm.example.com/reconcile',RECON_INVOICE_BASE_URL:'https://invoice.example.com/reconcile'};
const request=(side='crm',entity_key='example-14')=>run('Validate Reconciliation Request',{source_side:side,body:{entity_key}},{vars}).json;
const fields={client_name:'Example Company',billing_email:'billing@example.test',billing_address:'Synthetic street 1',tax_id:'EXAMPLE-14',deal_stage:'won',invoice_number:'EX-14',invoice_status:'issued',paid_at_utc:null,balance_due_minor:12900,currency:'PLN',invoice_due_at_utc:'2026-09-30T10:00:00Z'};
const snap=(side='crm',f={},extra={})=>({entity_key:'example-14',record_id:side+'-record-14',revision:side+'-v1',deleted:false,last_sync_write_id:'',fields:{...fields,...f},...extra});
const http=b=>({statusCode:200,headers:{etag:'"'+b.revision+'"'},body:b});
const history=(rows=[],p=request())=>run('Check Reconciliation Journal',{}, {inputRows:rows.length?rows:[{}],nodeOutputs:{'Validate Reconciliation Request':p}}).json;
function plan(side='crm',crm=snap(),invoice=snap('invoice',{client_name:'Old company'}),h=[]){
 const p=history(h,request(side));return run('Plan Owner Field Patch',{}, {nodeOutputs:{'Check Reconciliation Journal':p,'Read Current CRM Record':http(crm),'Read Current Invoice Record':http(invoice)}}).json;
}
function intent(p=plan()) {return run('Verify Reconciliation Intent',{}, {inputRows:[{...p.intent,id:1}],nodeOutputs:{'Plan Owner Field Patch':p}}).json;}
function source(p=intent(),s=p.source){return run('Verify Source Is Still Current',http(s),{nodeOutputs:{'Verify Reconciliation Intent':p}}).json;}
function ack(p=source(),raw){const target={...p.target,fields:{...p.target.fields,...p.patch},revision:'written-v2',last_sync_write_id:p.event_key};return run('Inspect Conditional Patch Result',raw||http(target),{nodeOutputs:{'Verify Source Is Still Current':p}}).json;}
function verified(p=ack(),raw){return run('Verify Applied Provider State',raw||http(p.acknowledged_snapshot),{nodeOutputs:{'Inspect Conditional Patch Result':p}}).json;}

test('source tokens are distinct, bounded and role-bound; duplicate auth headers fail',()=>{
 for(const role of ['CRM','INVOICE']){
  const good=run('Authenticate Reconciliation Source',{headers:{authorization:'Bearer '+vars['RECON_'+role+'_TOKEN']},body:{entity_key:'example-14'}},{vars}).json;
  assert.equal(good.source_side,role.toLowerCase());assert.equal(good.auth_ok,true);assert.equal('headers' in good,false);
 }
 const token=vars.RECON_CRM_TOKEN;
 for(const headers of [{},{authorization:'wrong'},{authorization:['Bearer '+token]},{authorization:'Bearer '+token,Authorization:'Bearer '+token},{authorization:'Bearer '+token+' '},{authorization:'Bearer incorrect-12345678901234567890'}])assert.equal(run('Authenticate Reconciliation Source',{headers},{vars}).json.auth_ok,false);
 for(const config of [{},{...vars,RECON_CRM_TOKEN:'short'},{...vars,RECON_INVOICE_TOKEN:token}])assert.equal(run('Authenticate Reconciliation Source',{headers:{authorization:'Bearer '+token}},{vars:config}).json.auth_ok,false);
});

test('caller contract contains only an opaque entity reference; endpoints are fixed HTTPS config',()=>{
 for(const body of [null,[],{}, {entity_key:'../private'}, {entity_key:'x',source_side:'invoice'}, {entity_key:'x',url:'https://evil.example'}, {entity_key:'x',patch:{tax_id:'123'}},{entity_key:'x'.repeat(129)}])assert.equal(run('Validate Reconciliation Request',{source_side:'crm',body},{vars}).json.valid,false);
 for(const url of ['http://crm.example.com','https://localhost','https://127.0.0.1','https://name:password@crm.example.com','https://crm.example.com?secret=abc','https://crm.example.com/#frag','https://crm.internal/records','https://crm.example.com/../records',vars.RECON_INVOICE_BASE_URL])assert.equal(run('Validate Reconciliation Request',{source_side:'crm',body:{entity_key:'x'}},{vars:{...vars,RECON_CRM_BASE_URL:url}}).json.valid,false,url);
 const p=request();assert.equal(p.valid,true);assert.match(p.entity_hash,/^[a-f0-9]{64}$/);assert.equal(request('invoice').entity_hash,p.entity_hash);assert.equal(p.crm_url,'https://crm.example.com/reconcile/example-14');
});

test('each direction patches only the owning side fields and does not trust echo markers',()=>{
 const c=snap('crm',{client_name:'CRM truth',invoice_number:'wrong invoice'}),i=snap('invoice',{client_name:'old name',invoice_number:'INV truth'});
 const a=plan('crm',c,i);assert.deepEqual(a.patch,{client_name:'CRM truth'});assert.equal(a.target_side,'invoice');
 const b=plan('invoice',c,i);assert.deepEqual(b.patch,{invoice_number:'INV truth'});assert.equal(b.target_side,'crm');
 const dirty=plan('crm',c,{...i,last_sync_write_id:'a'.repeat(64)});assert.equal(dirty.needs_patch,true);
 const clean=plan('crm',c,{...i,fields:{...i.fields,client_name:c.fields.client_name},last_sync_write_id:'b'.repeat(64)});assert.equal(clean.status,'unchanged');
 assert.equal(plan('crm',c,i).event_key,a.event_key);
});

test('missing, malformed, duplicate-shaped or tombstoned records cannot produce a patch',()=>{
 const p=history();
 for(const raw of [{error:'private provider error'},{statusCode:404,body:{}},http([snap()]),{...http(snap()),headers:{etag:'W/"crm-v1"'}},http({...snap(),entity_key:'other'}),http({...snap(),record_id:''}),http({...snap(),fields:{...fields,balance_due_minor:-1}}),http({...snap(),fields:{...fields,balance_due_minor:'12900'}}),http({...snap(),fields:{...fields,invoice_status:'paid'}}),http({...snap(),fields:{...fields,invoice_due_at_utc:'2026-02-30T10:00:00Z'}}),http({...snap(),fields:{...fields,private_payload:'extra'}})]){
  const r=run('Plan Owner Field Patch',{}, {nodeOutputs:{'Check Reconciliation Journal':p,'Read Current CRM Record':raw,'Read Current Invoice Record':http(snap('invoice'))}}).json;
  assert.equal(r.needs_patch,false);assert.equal(r.reason,'missing_or_invalid_provider_record');assert.equal(JSON.stringify(r).includes('private provider error'),false);
 }
 for(const side of ['crm','invoice']){
  const c=snap(),i=snap('invoice'); const record=side==='crm'?c:i;record.deleted=true;record.fields=null;
  assert.equal(plan('crm',c,i).reason,'tombstone_no_write');
 }
});

test('journal rejects ambiguous state and blocks pending writes across both directions',()=>{
 const p=plan(),r={...p.intent,id:1};
 for(const status of ['intent','reconcile_required'])assert.equal(history([{...r,status}],request('invoice')).clear,false);
 const applied={...r,status:'applied',result_revision:'written-v2'};
 assert.equal(history([applied]).clear,true);
 for(const rows of [[applied,{...applied,id:2}],[{...applied,id:0}],[{error:'storage failed'}],[{...applied,entity_hash:'b'.repeat(64)}],[{...applied,status:'arbitrary'}],[{...applied,changed_fields:'invoice_number'}],[{...applied,created_at_utc:'yesterday'}],[{...applied,result_revision:''}]])assert.equal(history(rows).reason,'invalid_or_duplicate_journal');
 assert.equal(plan('crm',snap(),snap('invoice',{client_name:'Old company'}),[applied]).status,'prior_plan_requires_review');
});

test('intent journal stores only minimized metadata and requires exact one-row acknowledgement',()=>{
 const p=plan();assert.equal(JSON.stringify(p.intent).includes(fields.billing_email),false);assert.equal('entity_key' in p.intent,false);assert.equal('patch' in p.intent,false);assert.equal('client_name' in p.intent,false);
 assert.equal(intent(p).journal_row_id,1);
 for(const rows of [[{}],[{error:'failed'}],[{...p.intent,id:1,source_revision:'wrong'}],[{...p.intent,id:1},{...p.intent,id:2}]])assert.throws(()=>run('Verify Reconciliation Intent',{}, {inputRows:rows,nodeOutputs:{'Plan Owner Field Patch':p}}),/persistence_unconfirmed/);
});

test('source preflight rejects changed revisions, changed values, deletion and unavailable source',()=>{
 const p=intent();assert.equal(source(p).source_current,true);
 for(const s of [{...p.source,revision:'crm-v2'},{...p.source,fields:{...p.source.fields,client_name:'changed'}},{...p.source,deleted:true,fields:null}]){const r=source(p,s);assert.equal(r.source_current,false);assert.equal(r.status,'conflict');}
 const failed=run('Verify Source Is Still Current',{error:'timeout'},{nodeOutputs:{'Verify Reconciliation Intent':p}}).json;assert.equal(failed.source_current,false);assert.equal(failed.reason,'source_unavailable');
});

test('write acknowledgement requires exact fields, stable identity, new revision and provider write marker',()=>{
 const p=source();assert.equal(ack(p).patch_acknowledged,true);
 const good={...p.target,fields:{...p.target.fields,...p.patch},revision:'written-v2',last_sync_write_id:p.event_key};
 for(const bad of [{...good,last_sync_write_id:''},{...good,revision:p.target.revision},{...good,record_id:'other-record'},{...good,fields:{...good.fields,invoice_number:'unexpected overwrite'}},{...good,fields:{...good.fields,client_name:'wrong'}}]){const r=ack(p,http(bad));assert.equal(r.patch_acknowledged,false);assert.equal(r.status,'reconcile_required');}
 for(const raw of [{error:'timeout with sensitive data'}, {statusCode:204,body:''},{statusCode:500,body:{code:'revision_conflict'}},{statusCode:412,body:{code:'arbitrary'}}])assert.equal(ack(p,raw).status,'reconcile_required');
 for(const statusCode of [409,412]){const r=ack(p,{statusCode,body:{code:'revision_conflict'}});assert.equal(r.patch_acknowledged,false);assert.equal(r.status,'conflict');assert.equal(r.reason,'target_conflict');}
});

test('applied requires an independent exact provider readback, including the new revision',()=>{
 const p=ack();assert.equal(verified(p).status,'applied');
 for(const raw of [{error:'read timeout'},http({...p.acknowledged_snapshot,revision:'concurrent-v3'}),http({...p.acknowledged_snapshot,fields:{...p.acknowledged_snapshot.fields,client_name:'concurrent'}})])assert.equal(verified(p,raw).status,'reconcile_required');
});

test('final state is minimized and success is emitted only after exact durable result',()=>{
 for(const full of [verified(),ack(source(),{error:'timeout'}),source(intent(),{...intent().source,revision:'changed-v2'})]){
  const p=run('Prepare Journal Outcome',full).json;
  assert.equal(JSON.stringify(p).includes(fields.billing_email),false);assert.equal('patch' in p,false);assert.equal('source' in p,false);
  const final=run('Verify Journal Outcome',{}, {inputRows:[{...p.expected,id:p.journal_row_id}],nodeOutputs:{'Prepare Journal Outcome':p}}).json;
  assert.equal(final.status,p.status);assert.equal(final.ok,p.status==='applied');
  for(const rows of [[{}],[{...p.expected,id:p.journal_row_id,reason:'wrong'}],[{...p.expected,id:999}],[{...p.expected,id:1},{...p.expected,id:2}]])assert.throws(()=>run('Verify Journal Outcome',{}, {inputRows:rows,nodeOutputs:{'Prepare Journal Outcome':p}}),/persistence_unconfirmed/);
 }
});

test('graph has real conditional HTTP boundaries and no simulator, credential, send or activation',()=>{
 const w=loadWorkflow(file);assert.equal(w.active,false);assert.deepEqual(w.pinData,{});assert.equal(w.settings.saveDataErrorExecution,'none');assert.equal(w.settings.saveDataSuccessExecution,'none');assert.equal(w.settings.saveManualExecutions,false);
 for(const n of w.nodes){assert.equal('credentials' in n,false);assert.equal(/gmail|executeCommand/.test(n.type),false);}
 const requests=w.nodes.filter(n=>n.type==='n8n-nodes-base.httpRequest');assert.equal(requests.length,8);
 for(const n of requests){assert.equal(n.retryOnFail,false);assert.equal(n.parameters.options.redirect.redirect.followRedirects,false);assert.equal(n.parameters.authentication,'genericCredentialType');}
 for(const n of requests.filter(n=>n.parameters.method==='PATCH'))assert.deepEqual(n.parameters.headerParameters.parameters.map(x=>x.name),['If-Match','Idempotency-Key']);
 const patches=requests.filter(n=>n.parameters.method==='PATCH').map(n=>n.name);
 function walk(from,visited=new Set()){if(visited.has(from))return visited;visited.add(from);for(const port of w.connections[from]?.main||[])for(const edge of port)walk(edge.node,visited);return visited;}
 for(const name of ['Reject Source Authentication','Respond Reconciliation Decision','Prepare Journal Outcome'])for(const patch of patches)assert.equal(walk(name).has(patch),false);
 const update=w.nodes.find(n=>n.name==='Persist Reconciliation Outcome');assert.equal(update.parameters.filters.conditions.find(x=>x.keyName==='status').keyValue,'intent');
});
