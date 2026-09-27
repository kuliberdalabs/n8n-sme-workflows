'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {executeCodeNode,loadWorkflow,workflowFile}=require('./helpers/workflow-vm');
const file=workflowFile('13-complaint-sla-intake');
const run=(name,input={},options={})=>executeCodeNode(file,name,{input,...options});
const stamp=hours=>new Date(Date.now()+hours*3600000).toISOString();
const payload=(changes={})=>({tenant_id:'tenant-example',source_ref:'ticket-013',category:'complaint',received_at_utc:stamp(-1),response_due_at_utc:stamp(48),policy_ref:'policy-v1',...changes});
const normal=(b=payload())=>run('Normalize Complaint Metadata',{body:b}).json;
const saved=(changes={})=>({...normal(),id:1,...(changes.ack_status==='acked'?{ack_at_utc:stamp(-0.5)}:{}),...changes});
const ownerVars={COMPLAINT_INTAKE_TOKEN:'intake-synthetic-1234567890',COMPLAINT_OWNER_TOKEN:'owner-synthetic-12345678901',COMPLAINT_LEAD_TOKEN:'lead-synthetic-123456789012',COMPLAINT_MANAGER_TOKEN:'manager-synthetic-12345678'};
const emails={COMPLAINT_OWNER_EMAIL:'owner@example.test',COMPLAINT_LEAD_EMAIL:'lead@example.test',COMPLAINT_MANAGER_EMAIL:'manager@example.test'};
function plan(r,history=[]){return run('Plan Complaint Alert',{}, {inputRows:history.length?history:[{}],nodeOutputs:{'Require One Current Case':r},vars:emails}).json;}
function history(p,id=100){return {id,event_key:p.event_key,case_key:p.case_key,event_status:'sent',event_kind:p.event_kind,owner_id:p.owner_id,event_at_utc:p.event_at_utc,gmail_message_id:'message-example',updated_at_utc:p.updated_at_utc};}

test('both webhook lanes fail closed and owner identity comes from distinct role credentials',()=>{
 for(const name of ['Authenticate Complaint Intake','Authenticate Complaint Owner']){
  for(const headers of [{},{authorization:'Bearer incorrect'},{authorization:['Bearer '+ownerVars.COMPLAINT_OWNER_TOKEN]},{authorization:'Bearer '+ownerVars.COMPLAINT_OWNER_TOKEN,Authorization:'Bearer '+ownerVars.COMPLAINT_OWNER_TOKEN}])assert.equal(run(name,{headers},{vars:{}}).json.auth_ok,false);
 }
 const raw={headers:{authorization:'Bearer '+ownerVars.COMPLAINT_INTAKE_TOKEN},body:payload()};
 const intake=run('Authenticate Complaint Intake',raw,{vars:ownerVars}).json;assert.equal(intake.auth_ok,true);assert.equal('headers' in intake,false);
 for(const role of ['OWNER','LEAD','MANAGER']){
  const r=run('Authenticate Complaint Owner',{headers:{authorization:'Bearer '+ownerVars['COMPLAINT_'+role+'_TOKEN'],'x-actor':'someone-else'},body:{}},{vars:ownerVars}).json;
  assert.equal(r.auth_ok,true);assert.equal(r.actor_id,role.toLowerCase());assert.equal('headers' in r,false);
 }
 for(const vars of [{...ownerVars,COMPLAINT_LEAD_TOKEN:ownerVars.COMPLAINT_OWNER_TOKEN},{...ownerVars,COMPLAINT_OWNER_TOKEN:ownerVars.COMPLAINT_INTAKE_TOKEN}])assert.equal(run('Authenticate Complaint Owner',{headers:{authorization:'Bearer '+vars.COMPLAINT_OWNER_TOKEN}},{vars}).json.auth_ok,false);
});

test('intake is metadata only with strict bounded identity and real offset timestamps',()=>{
 for(const patch of [{customer_email:'person@example.test'},{body:'private'},{attachments:[]},{source_ref:'X'.repeat(1000000)},{source_ref:{bad:1}},{tenant_id:null},{category:'guess'},{received_at_utc:'2026-09-01T09:00:00'},{received_at_utc:'2026-02-30T09:00:00Z'},{received_at_utc:stamp(1)},{response_due_at_utc:'2026-01-01T00:00:00Z'},{policy_ref:''}]){
  const result=normal(payload(patch));assert.equal(result.valid,false,JSON.stringify(Object.keys(patch)));assert.ok(JSON.stringify(result).length<1000);
 }
 for(const value of [[],null,'text'])assert.equal(normal(value).valid,false);
 const p=payload();const a=normal(p),b=normal(p);assert.equal(a.case_key,b.case_key);assert.equal(a.intake_fingerprint,b.intake_fingerprint);
 const changed=normal({...p,category:'other'});assert.equal(a.case_key,changed.case_key);assert.notEqual(a.intake_fingerprint,changed.intake_fingerprint);
 assert.equal(normal(payload({response_due_at_utc:null,policy_ref:''})).deadline_status,'needs_deadline_review');
 assert.equal(normal(payload({response_due_at_utc:null,policy_ref:'guess'})).valid,false);
 const tz=normal(payload({received_at_utc:'2026-09-01T12:00:00+02:00',response_due_at_utc:'2026-09-03T12:00:00+02:00'}));assert.equal(tz.received_at_utc,'2026-09-01T10:00:00.000Z');
});

test('stable case identity rejects conflicts and every ambiguous physical result',()=>{
 const n=normal(),r={...n,id:1};const resolve=rows=>run('Resolve Complaint Identity',{}, {inputRows:rows.length?rows:[{}],nodeItems:{'Normalize Complaint Metadata':[n]}}).json;
 assert.equal(resolve([]).create_case,true);assert.equal(resolve([r]).status,'duplicate');
 assert.equal(resolve([{...r,intake_fingerprint:'a'.repeat(64)}]).status,'identity_conflict');
 for(const rows of [[r,{...r,id:2}],[{error:'db failed'}],[{...r,id:null}]])assert.equal(resolve(rows).status,'ambiguous_case_reconcile_required');
});

test('intake only returns created after exact acknowledged persistence',()=>{
 const n={...normal(),create_case:true};const verify=rows=>run('Verify Complaint Persistence',{}, {inputRows:rows,nodeItems:{'Resolve Complaint Identity':[n]}}).json;
 assert.equal(verify([{...n,id:1}]).status,'created');
 for(const rows of [[{}],[{error:'failed'}],[{...n,id:1,owner_id:'manager'}],[{...n,id:1},{...n,id:2}]])assert.equal(verify(rows).http_status,503);
});

test('owner action validates closure evidence and never accepts claimed actor identity',()=>{
 const base={case_key:'a'.repeat(64),action:'ack',expected_revision:1,resolution_ref:''};
 for(const patch of [{resolution_ref:'not-for-ack'},{actor_id:'manager'},{expected_revision:0},{case_key:'<script>'},{action:'close'}])assert.equal(run('Normalize Owner Action',{body:{...base,...patch},actor_id:'owner'}).json.valid,false);
 assert.equal(run('Normalize Owner Action',{body:{...base,action:'close',resolution_ref:'source-resolution-013'},actor_id:'owner'}).json.actor_id,'owner');
});

test('only current assigned owner can ack or close, stale writes reject and exact replays converge',()=>{
 const r=saved();const n={case_key:r.case_key,actor_id:'owner',action:'ack',expected_revision:r.revision,resolution_ref:''};
 const resolve=(caseRow,action=n)=>run('Resolve Owner Action',{}, {inputRows:[caseRow],nodeItems:{'Normalize Owner Action':[action]}}).json;
 assert.equal(resolve(r,{...n,actor_id:'lead'}).http_status,403);
 assert.equal(resolve(r,{...n,expected_revision:2}).status,'case_state_conflict');
 const ack=resolve(r);assert.equal(ack.ack_status,'acked');assert.equal(ack.lifecycle_status,'open');assert.equal(ack.response_due_at_utc,r.response_due_at_utc);
 assert.equal(resolve({...r,...ack}).status,'already_acknowledged');
 const close=resolve(r,{...n,action:'close',resolution_ref:'resolution-013'});assert.equal(close.lifecycle_status,'closed');
 assert.equal(resolve(close,{...n,action:'close',resolution_ref:'resolution-013'}).status,'already_closed');
 assert.equal(resolve(close,{...n,action:'close',resolution_ref:'different'}).http_status,409);
});

test('owner update checks durable results before acknowledging the action',()=>{
 const n=saved({row_id:1,revision:2,ack_status:'acked'});
 const verify=rows=>run('Verify Owner Action',{}, {inputRows:rows,nodeItems:{'Resolve Owner Action':[n]}}).json;
 assert.equal(verify([n]).status,'acknowledged');
 for(const rows of [[{}],[{...n,revision:1}],[n,{...n,id:2}]])assert.equal(verify(rows).http_status,409);
});

test('acknowledgement leaves independent response-deadline alerts running and closure stops them',()=>{
 const r=saved({ack_status:'acked',response_due_at_utc:stamp(-1),received_at_utc:stamp(-48)});
 const p=plan(r);assert.equal(p.event_kind,'deadline_breached_day_0');assert.equal(p.ack_status,'acked');assert.equal(p.alert_recipient,'owner@example.test');
 assert.equal(plan({...r,lifecycle_status:'closed'}).has_action,false);
 const noDeadline=plan(saved({ack_status:'acked',response_due_at_utc:null,policy_ref:''}));assert.equal(noDeadline.event_kind,'needs_deadline_review');
 const scheduled=plan(saved({ack_status:'acked',response_due_at_utc:stamp(100)}));assert.equal(scheduled.has_action,false);
});

test('owner escalation is sequential, configured and unaffected by complaint category',()=>{
 const r=saved({response_due_at_utc:stamp(100),owner_assigned_at_utc:stamp(-3)});
 const p=plan(r);assert.equal(p.owner_id,'lead');assert.equal(p.owner_level,1);assert.equal(p.event_kind,'owner_1');assert.equal(p.alert_recipient,'lead@example.test');
 assert.equal(plan({...r,category:'reclamation'}).owner_id,'lead');
 const top=plan({...r,owner_id:'manager',owner_level:2,owner_assigned_at_utc:stamp(-26)});assert.equal(top.event_kind,'owner_2_day_1');
 assert.equal(plan({...r,ack_status:'acked'}).has_action,false);
});

test('sent events suppress sequential duplicates while uncertain or duplicate ledger rows stop resend',()=>{
 const r=saved({ack_status:'acked',response_due_at_utc:stamp(-1),received_at_utc:stamp(-48)}),p=plan(r),h=history(p);
 assert.equal(plan(r,[h]).has_action,false);
 for(const rows of [[{...h,event_status:'intent'}],[{...h,event_status:'reconcile_required'}],[{...h,gmail_message_id:''}],[h,{...h,id:101}],[{error:'failed'}]])assert.throws(()=>plan(r,rows),/reconcile/);
 const next=plan({...r,response_due_at_utc:stamp(-25)},[h]);assert.equal(next.event_kind,'deadline_breached_day_1');
});

test('multiple cases preserve their own references and alert hashes',()=>{
 const a=saved({source_ref:'source-a'}),b=saved({case_key:'b'.repeat(64),source_ref:'source-b',id:2});
 const pa=plan(a),pb=plan(b);assert.notEqual(pa.event_key,pb.event_key);assert.equal(pb.case_key,b.case_key);assert.ok(pb.alert_text.includes(b.case_key));assert.ok(!pb.alert_text.includes(a.case_key));
 const select=rows=>run('Select Unique Open Cases',{}, {inputRows:rows});
 assert.equal(select([a,b]).length,2);assert.throws(()=>select([a,{...a,id:3}]),/Duplicate/);assert.throws(()=>select([{...a,revision:null}]),/Invalid/);
});

test('case and alert intent writes must be acknowledged before any send',()=>{
 const p=plan(saved());
 const state=rows=>run('Verify Complaint Alert State',{}, {inputRows:rows,nodeOutputs:{'Plan Complaint Alert':p}}).json;
 assert.equal(state([p]).event_key,p.event_key);
 for(const rows of [[{}],[{...p,revision:p.revision-1}],[p,{...p,id:2}],[{...p,ack_status:'acked'}]])assert.throws(()=>state(rows),/no alert sent/);
 const intent=rows=>run('Verify Complaint Alert Intent',{}, {inputRows:rows,nodeOutputs:{'Verify Complaint Alert State':p}}).json;
 const h={...p,id:7};assert.equal(intent([h]).event_row_id,7);
 for(const rows of [[{}],[{...h,event_status:'sent'}],[h,{...h,id:8}]])assert.throws(()=>intent(rows),/no email sent/);
});

test('provider errors and missing ids remain uncertain and are not retried automatically',()=>{
 const p={...plan(saved()),event_row_id:7};
 const capture=rows=>run('Capture Complaint Alert Outcome',{}, {inputRows:rows,nodeOutputs:{'Verify Complaint Alert Intent':p}}).json;
 assert.equal(capture([{id:'gmail-message-example'}]).event_status,'sent');
 for(const rows of [[{}],[{error:'timeout'}],[{id:'x',error:'ambiguous'}],[{id:'x'},{id:'y'}]])assert.equal(capture(rows).event_status,'reconcile_required');
 const n=capture([{id:'gmail-message-example'}]);
 const verify=rows=>run('Verify Complaint Alert Outcome',{}, {inputRows:rows,nodeOutputs:{'Capture Complaint Alert Outcome':n}}).json;
 assert.equal(verify([{...n,id:7}]).status,'sent');assert.throws(()=>verify([{...n,id:7,event_status:'intent'}]),/uncertain/);
});

test('native graph is inactive, metadata scoped and persistence precedes internal Gmail',()=>{
 const w=loadWorkflow(file),byName=n=>w.nodes.find(x=>x.name===n);
 assert.equal(w.active,false);assert.equal(w.settings.timezone,'UTC');assert.ok(!w.pinData&&!w.staticData);
 for(const n of w.nodes){assert.ok(n.type.startsWith('n8n-nodes-base.'));assert.ok(!n.credentials);}
 const mail=w.nodes.filter(n=>n.type==='n8n-nodes-base.gmail');assert.equal(mail.length,1);assert.equal(mail[0].parameters.sendTo,'={{ $json.alert_recipient }}');assert.equal(mail[0].retryOnFail,false);
 const incoming=name=>Object.entries(w.connections).filter(([,c])=>c.main.some(b=>b.some(e=>e.node===name))).map(([n])=>n);
 assert.deepEqual(incoming(mail[0].name),['Verify Complaint Alert Intent']);
 assert.deepEqual(incoming('Verify Complaint Alert Intent'),['Insert Complaint Alert Intent']);
 assert.deepEqual(w.connections['Loop Complaint Cases'].main[1].map(e=>e.node),['Recheck Current Complaint']);
 for(const name of ['Persist Owner Action','Persist Complaint Alert State']){const f=byName(name).parameters.filters.conditions;assert.deepEqual(f.map(x=>x.keyName),['id','case_key','revision','lifecycle_status']);}
 const columns=Object.keys(byName('Insert Complaint Case').parameters.columns.value);for(const k of ['customer_email','name','body','subject','attachments','content_url'])assert.ok(!columns.includes(k));
});

test('annotation changes positions only and contains a complete setup overview',()=>{
 const a=loadWorkflow(file.replace('workflow.json','workflow-annotated-v2.json')),w=loadWorkflow(file);
 const functional=a.nodes.filter(n=>n.type!=='n8n-nodes-base.stickyNote');
 const normalize=ns=>ns.map(({position,...n})=>n);
 assert.deepEqual(normalize(functional),normalize(w.nodes));assert.deepEqual(a.connections,w.connections);
 const notes=a.nodes.filter(n=>n.type==='n8n-nodes-base.stickyNote');assert.equal(notes.length,8);
});

test('audit regression: invalid persisted state never becomes an oversized successful reply',()=>{
 const n=normal(),r={...n,id:1};
 for(const patch of [{deadline_status:'x'.repeat(90000)},{lifecycle_status:'closed',resolution_ref:'',closed_at_utc:null},{ack_status:'acked',ack_at_utc:null}]){
  const result=run('Resolve Complaint Identity',{}, {inputRows:[{...r,...patch}],nodeItems:{'Normalize Complaint Metadata':[n]}}).json;
  assert.equal(result.http_status,409);assert.ok(JSON.stringify(result).length<500);
 }
});

test('audit regression: changed deadlines and missing write timestamps block successful effects',()=>{
 const n=saved({row_id:1,revision:2,lifecycle_status:'closed',resolution_ref:'resolution-013',closed_at_utc:stamp(0)});
 const close=run('Verify Owner Action',{}, {inputRows:[{...n,closed_at_utc:null}],nodeItems:{'Resolve Owner Action':[n]}}).json;assert.equal(close.http_status,409);
 const p=plan(saved({response_due_at_utc:stamp(-1),received_at_utc:stamp(-48)}));
 assert.throws(()=>run('Verify Complaint Alert State',{}, {inputRows:[{...p,response_due_at_utc:stamp(72),policy_ref:'different'}],nodeOutputs:{'Plan Complaint Alert':p}}),/no alert sent/);
 assert.throws(()=>run('Verify Complaint Alert Intent',{}, {inputRows:[{...p,id:7,event_at_utc:null,updated_at_utc:null}],nodeOutputs:{'Verify Complaint Alert State':p}}),/no email sent/);
});

test('audit regression: a durably recorded Gmail uncertainty immediately raises an execution error',()=>{
 const p={...plan(saved()),event_row_id:7};
 const n=run('Capture Complaint Alert Outcome',{}, {inputRows:[{error:'timeout'}],nodeOutputs:{'Verify Complaint Alert Intent':p}}).json;
 assert.equal(n.event_status,'reconcile_required');
 assert.throws(()=>run('Verify Complaint Alert Outcome',{}, {inputRows:[{...n,id:7}],nodeOutputs:{'Capture Complaint Alert Outcome':n}}),/reconcile_required persisted/);
});
