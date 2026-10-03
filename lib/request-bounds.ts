export const MAX_JSON_BYTES=1_000_000;

export class RequestBodyError extends Error {
  readonly status:400|413;
  constructor(message:string,status:400|413){super(message);this.status=status;}
}

export function contentLengthTooLarge(request:Request,maxBytes=MAX_JSON_BYTES):boolean {
  const raw=request.headers.get("content-length");
  return raw!==null&&/^\d+$/.test(raw)&&Number(raw)>maxBytes;
}

export async function readBoundedUtf8(request:Request,maxBytes=MAX_JSON_BYTES):Promise<string> {
  if(contentLengthTooLarge(request,maxBytes))throw new RequestBodyError("Request is too large.",413);
  if(!request.body)return "";
  const reader=request.body.getReader(),parts:Uint8Array[]=[];
  let size=0;
  try {
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      size+=value.byteLength;
      if(size>maxBytes){await reader.cancel();throw new RequestBodyError("Request is too large.",413);}
      parts.push(value);
    }
  } finally {reader.releaseLock();}
  const bytes=new Uint8Array(size);
  let offset=0;
  for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}
  try{return new TextDecoder("utf-8",{fatal:true}).decode(bytes);}
  catch{throw new RequestBodyError("Request must use valid UTF-8.",400);}
}
