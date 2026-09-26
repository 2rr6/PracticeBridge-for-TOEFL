import {readFileSync} from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';

const schema=JSON.parse(readFileSync(new URL('../docs/practicebridge.v2.schema.json',import.meta.url),'utf8'));
const ajv=new Ajv2020({strict:true,allowUnionTypes:true,allErrors:true,useDefaults:false,coerceTypes:false,removeAdditional:false});
const normalizedValidator=ajv.compile(schema);
// Input may omit only fields filled by the existing normalization step. Keep
// every type and nested additionalProperties boundary before that projection.
const inputSchema=structuredClone(schema);
const optional=(object,names)=>{object.required=object.required.filter(name=>!names.includes(name));};
optional(inputSchema,['description','rights']);
const group=inputSchema.properties.groups.items,question=group.properties.questions.items;
optional(group,['passage','audio','image']);
optional(question,['options','answer','explanation','audio','image','timeLimitSeconds','prepareSeconds','source']);
const inputValidator=ajv.compile(inputSchema);

export function validateV2Structure(pack,{normalized=false}={}){
  const validate=normalized?normalizedValidator:inputValidator;
  return validate(pack)?[]:validate.errors.map(error=>({severity:'error',path:error.instancePath||'pack',message:`v2 结构无效：${error.message}${error.params.additionalProperty?` (${error.params.additionalProperty})`:''}。`}));
}
