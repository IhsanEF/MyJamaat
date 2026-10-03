"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { type CopyKey, type UiLocale, uiDirection, uiLocale, uiText } from "@/lib/ui-localization";

const LocaleContext=createContext<UiLocale>("en-CA");

export function UiLocaleProvider({children}:{children:React.ReactNode}) {
  const [locale,setLocale]=useState<UiLocale>("en-CA");
  useEffect(()=>{
    const selected=uiLocale(new URLSearchParams(window.location.search).get("uiLocale"));
    setLocale(selected);
    document.documentElement.lang=selected;
    document.documentElement.dir=uiDirection(selected);
    return ()=>{document.documentElement.lang="en";document.documentElement.dir="ltr";};
  },[]);
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useUiLocale() {
  const locale=useContext(LocaleContext);
  return {locale,direction:uiDirection(locale),t:(key:CopyKey)=>uiText(locale,key)};
}

export function UiCopy({id,before="",after=""}:{id:CopyKey;before?:string;after?:string}) {
  const {t}=useUiLocale();
  return <>{before}{t(id)}{after}</>;
}

export function UiOption({id,...props}:Omit<React.ComponentProps<"option">,"children">&{id:CopyKey}) {
  const {t}=useUiLocale();
  return <option {...props}>{t(id)}</option>;
}
