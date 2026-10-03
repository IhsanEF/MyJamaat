export type ImportMapping = { name:number|null; phone:number|null; email:number|null };
export type ImportSheet = { name:string; rows:string[][] };
export type ImportCandidate = { rowNumber:number; name:string; phone:string; email:string };

const normalizeHeader = (value:string) => value.toLowerCase().replace(/[^a-z]/g,"");
const nameHeaders = new Set(["name","fullname","person","personname","member","membername","worker","workername"]);
const phoneHeaders = new Set(["phone","phonenumber","mobile","mobilenumber","cell","cellphone","telephone","contactnumber"]);
const emailHeaders = new Set(["email","emailaddress","mail","mailaddress"]);
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function suggestLayout(rows:string[][]) {
  const scan = rows.slice(0,Math.min(rows.length,20));
  for (let index=0;index<scan.length;index++) {
    const cells=scan[index].map(normalizeHeader);
    if (cells.some(cell=>nameHeaders.has(cell)) && (cells.some(cell=>phoneHeaders.has(cell)||emailHeaders.has(cell)) || cells.length===1 || index<5)) {
      return {startRow:index+1,hasHeader:true,mapping:suggestMapping(rows,index+1,true),explanation:"Recognized column names. Check the suggested mapping before import."};
    }
  }
  const first=rows.findIndex(row=>row.some(cell=>cell.trim()));
  const startRow=first<0?1:first+1;
  return {startRow,hasHeader:false,mapping:suggestMapping(rows,startRow,false),explanation:"No clear header found. The first selected row is kept as a person; check the columns."};
}

export function suggestMapping(rows:string[][],startRow:number,hasHeader:boolean):ImportMapping {
  const width=Math.max(0,...rows.slice(Math.max(0,startRow-1),Math.min(rows.length,startRow+9)).map(row=>row.length));
  if (!width) return {name:null,phone:null,email:null};
  const headers=hasHeader?(rows[startRow-1]||[]).map(normalizeHeader):[];
  const find=(terms:Set<string>)=>{const index=headers.findIndex(cell=>terms.has(cell));return index<0?null:index;};
  const name=find(nameHeaders)??0;
  let phone=find(phoneHeaders), email=find(emailHeaders);
  if (!hasHeader) {
    const sample=rows.slice(startRow-1,Math.min(rows.length,startRow+9));
    for (let col=0;col<width;col++) {
      if (col===name) continue;
      const values=sample.map(row=>String(row[col]||"").trim()).filter(Boolean);
      if (values.some(value=>emailPattern.test(value)) && email===null) email=col;
      else if (values.some(value=>/^[+()\d\s.-]{7,}$/.test(value)&&/\d{6,}/.test(value.replace(/\D/g,""))) && phone===null) phone=col;
    }
  }
  return {name,phone,email};
}

export function mappingError(mapping:ImportMapping) {
  if (mapping.name===null) return "Choose a name column.";
  const selected=[mapping.name,mapping.phone,mapping.email].filter((value):value is number=>value!==null);
  if (new Set(selected).size!==selected.length) return "Choose a different column for each mapped detail.";
  return "";
}

export function candidateFromRow(row:string[],rowNumber:number,mapping:ImportMapping):ImportCandidate {
  const at=(index:number|null)=>index===null?"":String(row[index]||"").trim();
  return {rowNumber,name:at(mapping.name),phone:at(mapping.phone),email:at(mapping.email)};
}

export function candidateError(row:ImportCandidate) {
  if (!row.name) return "Name is required.";
  if (row.name.length>100) return "Name is over 100 characters.";
  if (row.phone.length>40) return "Phone is over 40 characters.";
  if (row.email.length>150) return "Email is over 150 characters.";
  if (row.email && !emailPattern.test(row.email)) return "Email address is invalid.";
  return "";
}

export function candidateKey(row:Pick<ImportCandidate,"name"|"phone"|"email">) {
  return [row.name.trim().toLowerCase(),row.phone.replace(/\D/g,""),row.email.trim().toLowerCase()].join("|");
}

export async function preflightXlsx(file:File) {
  if (file.size>2_000_000) throw new Error("Choose a file under 2 MB.");
  const bytes=new DataView(await file.arrayBuffer());
  let end=-1;
  for(let at=bytes.byteLength-22;at>=Math.max(0,bytes.byteLength-65_557);at--) {
    if (bytes.getUint32(at,true)===0x06054b50) {end=at;break;}
  }
  if(end<0) throw new Error("This is not a supported .xlsx file.");
  const entries=bytes.getUint16(end+10,true),directorySize=bytes.getUint32(end+12,true),directoryOffset=bytes.getUint32(end+16,true);
  if(!entries||entries>200||directorySize===0xffffffff||directoryOffset===0xffffffff||directoryOffset+directorySize>end) throw new Error("This workbook is too large or unsupported.");
  let offset=directoryOffset,total=0;
  for(let index=0;index<entries;index++) {
    if(offset+46>bytes.byteLength||bytes.getUint32(offset,true)!==0x02014b50) throw new Error("This workbook archive is invalid.");
    const flags=bytes.getUint16(offset+8,true),method=bytes.getUint16(offset+10,true),compressed=bytes.getUint32(offset+20,true),expanded=bytes.getUint32(offset+24,true);
    const nameLength=bytes.getUint16(offset+28,true),extraLength=bytes.getUint16(offset+30,true),commentLength=bytes.getUint16(offset+32,true);
    if((flags&1)!==0||![0,8].includes(method)||compressed===0xffffffff||expanded===0xffffffff) throw new Error("Encrypted or unsupported workbooks cannot be imported.");
    total+=expanded;
    if(expanded>4_000_000||total>8_000_000) throw new Error("The expanded workbook is too large to review safely.");
    offset+=46+nameLength+extraLength+commentLength;
  }
  if(offset>directoryOffset+directorySize) throw new Error("This workbook archive is invalid.");
}

export function boundSheets(sheets:ImportSheet[]) {
  if (!sheets.length||sheets.length>20) throw new Error("Choose a workbook with at most 20 sheets.");
  for (const sheet of sheets) {
    if(sheet.rows.length>1_000) throw new Error(`Sheet ${sheet.name} has over 1,000 rows. Use a smaller file.`);
    let characters=0;
    for (const row of sheet.rows) {
      if(row.length>30) throw new Error(`Sheet ${sheet.name} has over 30 columns.`);
      for(const cell of row) {
        if(cell.length>1_000) throw new Error(`Sheet ${sheet.name} has a cell over 1,000 characters.`);
        characters+=cell.length;
      }
    }
    if(characters>2_000_000) throw new Error(`Sheet ${sheet.name} has too much text to review safely.`);
  }
}
