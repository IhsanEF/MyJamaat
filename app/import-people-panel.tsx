"use client";

import { useMemo, useRef, useState } from "react";
import { UiCopy, UiOption, useUiLocale } from "@/app/ui-locale";
import { formatUiNumber, uiFieldLabel, uiStatusLabel } from "@/lib/ui-localization";
import Papa from "papaparse";
import readExcelFile from "read-excel-file/browser";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { boundSheets, candidateError, candidateFromRow, candidateKey, mappingError, preflightXlsx, suggestLayout, suggestMapping, type ImportCandidate, type ImportMapping, type ImportSheet } from "@/lib/roster-import";

type Outcome = {status:"added"|"duplicate"|"rejected";reason?:string};
type SaveResult = {added:number;duplicate:number;rejected:number;results:{rowNumber:number;status:Outcome["status"];reason?:string}[]};
type VisiblePerson = {name:string;phone:string|null;email:string|null};

export function ImportPeoplePanel({people,jamaatId,busy,serverError,send}:{people:VisiblePerson[];jamaatId?:string;busy:boolean;serverError:string;send:(payload:Record<string,unknown>,close?:boolean)=>Promise<unknown>}) {
  const {locale,t}=useUiLocale();
  const count=(value:number)=>formatUiNumber(value,locale);
  const explanationText=(value:string)=>value==="Recognized column names. Check the suggested mapping before import."?t("import.recognizedHeader"):value==="No clear header found. The first selected row is kept as a person; check the columns."?t("import.noHeader"):value==="Review the selected data area and column mapping before importing."?t("import.reviewLayout"):value;
  const generation=useRef(0);
  const [fileName,setFileName]=useState("");
  const [sheets,setSheets]=useState<ImportSheet[]>([]);
  const [sheetIndex,setSheetIndex]=useState(0);
  const [startRow,setStartRow]=useState(1);
  const [hasHeader,setHasHeader]=useState(false);
  const [mapping,setMapping]=useState<ImportMapping>({name:null,phone:null,email:null});
  const [explanation,setExplanation]=useState("");
  const [overrides,setOverrides]=useState<Record<number,Partial<ImportCandidate>>>({});
  const [outcomes,setOutcomes]=useState<Record<number,Outcome>>({});
  const [reviewed,setReviewed]=useState(false);
  const [previewOpened,setPreviewOpened]=useState(false);
  const [reading,setReading]=useState(false);
  const [error,setError]=useState("");
  const [summary,setSummary]=useState("");
  const sheet=sheets[sheetIndex];
  const width=sheet?Math.max(0,...sheet.rows.slice(Math.max(0,startRow-1)).map(row=>row.length)):0;
  const columnOptions=Array.from({length:width},(_,index)=>({value:String(index),label:hasHeader?sheet?.rows[startRow-1]?.[index]?.trim()||`${t("import.column")} ${count(index+1)}`:`${t("import.column")} ${count(index+1)}`}));
  const resetReview=()=>{setOverrides({});setOutcomes({});setReviewed(false);setPreviewOpened(false);setSummary("");setError("");};
  const selectSheet=(index:number,all:ImportSheet[]=sheets)=>{
    const suggestion=suggestLayout(all[index].rows);
    setSheetIndex(index);setStartRow(suggestion.startRow);setHasHeader(suggestion.hasHeader);setMapping(suggestion.mapping);setExplanation(suggestion.explanation);resetReview();
  };
  const openFile=async(file:File)=>{
    const current=++generation.current;
    setFileName(file.name);setSheets([]);setReading(true);setError("");setSummary("");setOutcomes({});setOverrides({});setReviewed(false);setPreviewOpened(false);
    try {
      if(file.size>2_000_000) throw new Error("Choose a file under 2 MB.");
      const extension=file.name.toLowerCase().split(".").pop();
      let loaded:ImportSheet[];
      if(extension==="xlsx") {
        await preflightXlsx(file);
        if(current!==generation.current) return;
        const workbook=await readExcelFile(file);
        loaded=workbook.map(part=>({name:part.sheet,rows:part.data.map(row=>row.map(cell=>String(cell??"")))}));
      } else if(extension==="csv") {
        const text=await file.text();
        if(current!==generation.current) return;
        const parsed=Papa.parse<string[]>(text,{skipEmptyLines:false});
        const parseError=parsed.errors.find(issue=>issue.code!=="UndetectableDelimiter");
        if(parseError) throw new Error(`CSV could not be read: ${parseError.message}`);
        loaded=[{name:"CSV",rows:parsed.data.map(row=>row.map(cell=>String(cell??"")))}];
      } else throw new Error("Choose a supported .csv or .xlsx file. Other spreadsheet formats are not available here.");
      if(current!==generation.current) return;
      boundSheets(loaded);
      if(!loaded.some(part=>part.rows.some(row=>row.some(cell=>cell.trim())))) throw new Error("This file has no people to review.");
      setSheets(loaded);selectSheet(0,loaded);
    } catch(cause) {if(current===generation.current)setError(cause instanceof Error?cause.message:"Could not read the file.");}
    finally {if(current===generation.current)setReading(false);}
  };
  const updateLayout=(row:number,header:boolean)=>{
    setStartRow(row);setHasHeader(header);setMapping(suggestMapping(sheet.rows,row,header));setExplanation("Review the selected data area and column mapping before importing.");resetReview();
  };
  const choice=(field:keyof ImportMapping,value:string)=>{setMapping(current=>({...current,[field]:value===""?null:Number(value)}));resetReview();};
  const rows=useMemo(()=>{
    if(!sheet) return [];
    const firstIndex=startRow-1+(hasHeader?1:0);
    const raw=sheet.rows.slice(firstIndex);
    return raw.map((cells,index)=>({cells,rowNumber:firstIndex+index+1})).filter(item=>item.cells.some(cell=>cell.trim())).map(item=>({...candidateFromRow(item.cells,item.rowNumber,mapping),...overrides[item.rowNumber]}));
  },[sheet,startRow,hasHeader,mapping,overrides]);
  const mappingProblem=mappingError(mapping);
  const visibleKeys=new Set(people.map(person=>candidateKey({name:person.name,phone:person.phone||"",email:person.email||""})));
  const seen=new Set<string>();
  const reviewedRows=rows.map(row=>{
    const invalid=candidateError(row),key=candidateKey(row);
    const possibleDuplicate=!invalid&&(seen.has(key)||visibleKeys.has(key));
    if(!invalid) seen.add(key);
    const outcome=outcomes[row.rowNumber];
    const status:string=outcome?.status|| (invalid?"rejected":possibleDuplicate?"duplicate":"ready");
    return {...row,status,reason:outcome?outcome.reason||"":invalid||(possibleDuplicate?t("import.exactRecord"):"")};
  });
  const ready=reviewedRows.filter(row=>row.status==="ready");
  const added=reviewedRows.filter(row=>row.status==="added").length;
  const invalid=reviewedRows.filter(row=>row.status==="rejected").length;
  const duplicates=reviewedRows.filter(row=>row.status==="duplicate").length;
  const edit=(rowNumber:number,field:"name"|"phone"|"email",value:string)=>{
    setOverrides(current=>({...current,[rowNumber]:{...current[rowNumber],[field]:value}}));
    setOutcomes(current=>{const updated={...current};delete updated[rowNumber];return updated;});
    setReviewed(false);setSummary("");setError("");
  };
  const importReady=async()=>{
    if(!reviewed||mappingProblem||!ready.length) return;
    const current=generation.current;
    const response=await send({action:"importPeople",...(jamaatId?{jamaatId}:{}),rows:ready.map(({rowNumber,name,phone,email})=>({rowNumber,name,phone,email}))},false) as SaveResult|null;
    if(current!==generation.current||!response?.results) return;
    const updated:Record<number,Outcome>={...outcomes,...Object.fromEntries(response.results.map(row=>[row.rowNumber,{status:row.status,reason:row.reason}]))};
    setOutcomes(updated);
    const statuses=reviewedRows.map(row=>updated[row.rowNumber]?.status||row.status);
    setSummary(`${count(statuses.filter(status=>status==="added").length)} ${t("inline.added")} ${count(statuses.filter(status=>status==="duplicate").length)} ${t("inline.exactDuplicates")} ${count(statuses.filter(status=>status==="rejected").length)} ${t("inline.rejectedEachRowRemainsAvailableForCorrection")} ${t("import.retryHelp")}`);
  };
  return <div className="import-panel">
    <label className="field"><span><UiCopy id="inline.excelOrCsvFile"/></span><Input type="file" accept=".xlsx,.csv" disabled={busy} onChange={event=>{const file=event.target.files?.[0];event.currentTarget.value="";if(file)void openFile(file);}}/></label>
    {fileName&&<p role="status"><UiCopy id="inline.selectedFile" after={" "}/><strong>{fileName}</strong>{reading?` · ${t("import.reading")}`:""}</p>}
    {reading&&<Button type="button" variant="outline" onClick={()=>{generation.current++;setReading(false);setSheets([]);setFileName("");setError("File reading cancelled.");}}><UiCopy id="inline.cancelReading"/></Button>}
    {sheet&&!reading&&<>
      {sheets.length>1&&<label className="field"><span><UiCopy id="inline.worksheet"/></span><NativeSelect value={String(sheetIndex)} onChange={event=>selectSheet(Number(event.target.value))}>{sheets.map((part,index)=><option value={index} key={index}>{part.name}</option>)}</NativeSelect></label>}
      <p className="form-hint">{explanationText(explanation)}</p>
      <div className="two-fields"><label className="field"><span><UiCopy id="inline.firstSelectedRow"/></span><Input type="number" min="1" max={sheet.rows.length} value={startRow} onChange={event=>{const row=Math.max(1,Math.min(sheet.rows.length,Number(event.target.value)||1));updateLayout(row,hasHeader);}}/></label><label className="field"><span><UiCopy id="inline.firstSelectedRowContains"/></span><NativeSelect value={hasHeader?"header":"person"} onChange={event=>updateLayout(startRow,event.target.value==="header")}><UiOption value="header" id="option.columnNames"/><UiOption value="person" id="option.aPerson"/></NativeSelect></label></div>
      <div className="mapping-row">{(["name","phone","email"] as const).map(field=><label className="field" key={field}><span>{uiFieldLabel(locale,field==="name"?"Name":field==="phone"?"Phone (optional)":"Email (optional)")}</span><NativeSelect value={mapping[field]===null?"":String(mapping[field])} onChange={event=>choice(field,event.target.value)}><option value="">{field==="name"?t("import.chooseColumn"):t("import.notPresent")}</option>{columnOptions.map(option=><option value={option.value} key={option.value}>{option.label}</option>)}</NativeSelect></label>)}</div>
      {mappingProblem&&<p role="alert" className="form-error">{mappingProblem}</p>}
      <p>{count(reviewedRows.length)}<UiCopy id="inline.selectedRows" before={" "} after={" "}/>{count(ready.length)}<UiCopy id="inline.ready" before={" "} after={" "}/>{count(added)}<UiCopy id="inline.added" before={" "} after={" "}/>{count(duplicates)}<UiCopy id="inline.exactDuplicates" before={" "} after={" "}/>{count(invalid)}<UiCopy id="inline.rejectedEachRowRemainsAvailableForCorrection" before={" "}/></p>
      {reviewedRows.length>500&&<p role="alert" className="form-error"><UiCopy id="inline.selectAtMost500PersonRowsAt"/></p>}
      <Button type="button" variant="outline" disabled={!!mappingProblem||!reviewedRows.length||reviewedRows.length>500} onClick={()=>{setReviewed(true);setPreviewOpened(true);setError("");}}><UiCopy id="inline.reviewSelectedRows"/></Button>
      {previewOpened&&<div className="import-preview" aria-label={t("import.rowReview")}>{reviewedRows.map(row=><div className="import-row" key={row.rowNumber}><strong><UiCopy id="inline.row" after={" "}/>{count(row.rowNumber)} · {uiStatusLabel(locale,row.status)}</strong>{row.reason&&<small>{row.reason}</small>}<div className="mapping-row"><label><UiCopy id="field.name"/><Input aria-label={`${t("inline.row")} ${count(row.rowNumber)} ${t("field.name")}`} value={row.name} disabled={busy||row.status==="added"} onChange={event=>edit(row.rowNumber,"name",event.target.value)}/></label><label><UiCopy id="inline.phone"/><Input aria-label={`${t("inline.row")} ${count(row.rowNumber)} ${t("inline.phone")}`} value={row.phone} disabled={busy||row.status==="added"} onChange={event=>edit(row.rowNumber,"phone",event.target.value)}/></label><label><UiCopy id="inline.email"/><Input aria-label={`${t("inline.row")} ${count(row.rowNumber)} ${t("inline.email")}`} value={row.email} disabled={busy||row.status==="added"} onChange={event=>edit(row.rowNumber,"email",event.target.value)}/></label></div></div>)}</div>}
      {reviewed&&<Button className="import-save" type="button" disabled={busy||!ready.length||reviewedRows.length>500} onClick={()=>void importReady()}><UiCopy id="inline.import" after={" "}/>{count(ready.length)}<UiCopy id="inline.ready_75c053" before={" "} after={" "}/>{t(ready.length===1?"import.person":"import.people")}</Button>}
      {summary&&<p role="status" className="notice">{summary}</p>}
    </>}
    {error&&<p role="alert" className="form-error">{error}</p>}
    {serverError&&<p role="alert" className="form-error">{serverError}</p>}
    <p className="form-hint"><UiCopy id="inline.importsAreLimitedTo500People1"/></p>
  </div>;
}
