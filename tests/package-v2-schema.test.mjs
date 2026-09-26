import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import {validatePackage,createPackageZip,parseNativeImport} from '../src/package.mjs';

const legacy={schemaVersion:1,id:'v2-schema-fixture',version:'1',title:'Self-authored schema fixture',groups:[{id:'g',section:'reading',taskKind:'read_daily',title:'Notice',passage:'The flag is blue.',questions:[{id:'q',type:'single_choice',prompt:'Which color?',options:[{id:'A',text:'Blue'},{id:'B',text:'Red'}],answer:'A'}]}]};
const fixture=()=>{const pack=validatePackage(legacy).pack;pack.schemaVersion=2;pack.coverageV1={materialCoverage:'partial',examCompleteness:'unknown',selectionCoverage:'selected-only'};pack.groups[0].questions[0].sourcePositionV1={sourceTaskId:'source-repeat',originalOrdinalInTask:6};pack.groups[0].questions[0].candidateLineageV1={candidateId:'candidate-00000000-0000-4000-8000-000000000001',revision:2,adaptationKind:null,parentCandidateId:null};return pack;};

test('published versioned canonical schemas accept unchanged v1 and actual v2 ZIP contents',async()=>{
  const ajv=new Ajv2020({strict:true,allowUnionTypes:true,allErrors:true,useDefaults:false,coerceTypes:false,removeAdditional:false});
  const v1=ajv.compile(JSON.parse(await fs.readFile(new URL('../docs/practicebridge.schema.json',import.meta.url),'utf8')));
  const v2=ajv.compile(JSON.parse(await fs.readFile(new URL('../docs/practicebridge.v2.schema.json',import.meta.url),'utf8')));
  const old=validatePackage(legacy).pack;assert.equal(v1(old),true,JSON.stringify(v1.errors));assert.equal(v2(old),false);
  const pack=fixture(),zip=await createPackageZip(pack,new Map()),imported=await parseNativeImport([{name:'v2.zip',data:zip.toString('base64')}]);
  assert.equal(v2(imported.pack),true,JSON.stringify(v2.errors));assert.equal(v1(imported.pack),false);assert.equal(imported.pack.groups[0].questions[0].sourcePositionV1.originalOrdinalInTask,6);assert.deepEqual(validatePackage(imported.pack).issues.filter(i=>i.severity==='error'),[]);
});

test('v2 runtime rejects nested unknowns and wrong types before projection without mutating input',()=>{
  const changes=[p=>p.groups[0].questions[0].options[0].future=true,p=>p.groups[0].questions[0].sourcePositionV1.originalOrdinalInTask='6',p=>p.coverageV1.future=true,p=>p.groups[0].presentation={screen:'all_questions',future:true},p=>p.groups[0].timing={scope:'task',durationSeconds:90,prepareSeconds:0,basis:'user',source:'Fixture',future:true},p=>{p.examContractVersion=1;p.minReaderVersion='0.5.0';p.examSets=[{id:'set',title:'Set',sections:[{id:'read',section:'reading',title:'Reading',modules:[{id:'m',title:'Module',sourceNumber:null,taskIds:['g'],instructions:{text:'Read.',future:true}}]}]}];}];
  for(const change of changes){const pack=fixture();change(pack);const before=structuredClone(pack);assert.ok(validatePackage(pack).issues.some(i=>i.severity==='error'),JSON.stringify(pack));assert.deepEqual(pack,before);}
  const v1=structuredClone(legacy);v1.oldUnknown='kept only in original';assert.deepEqual(validatePackage(v1).issues.filter(i=>i.severity==='error'),[],'v1 compatibility projection remains unchanged');
});

test('v2 export refuses malformed normalized data and unknown source positions stay explicit',async()=>{
  const pack=fixture();pack.groups[0].questions[0].sourcePositionV1.originalOrdinalInTask=null;
  assert.deepEqual(validatePackage(pack).issues.filter(i=>i.severity==='error'),[]);
  const imported=await parseNativeImport([{name:'unknown.zip',data:(await createPackageZip(pack,new Map())).toString('base64')}]);assert.equal(imported.pack.groups[0].questions[0].sourcePositionV1.originalOrdinalInTask,null);
  pack.groups[0].questions[0].candidateLineageV1.future=true;
  await assert.rejects(createPackageZip(pack,new Map()),/v2 结构无效/);
});
