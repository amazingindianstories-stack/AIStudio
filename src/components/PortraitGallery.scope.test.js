import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { PortraitGallery } from "./PortraitGallery.jsx";
import { useStore } from "../lib/store";

test("portrait character filter survives same-scope reopen and resets across project and actor switches", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const keys = ["window", "document", "HTMLElement", "React", "IS_REACT_ACT_ENVIRONMENT"];
  const beforeGlobals = Object.fromEntries(keys.map(k=>[k,globalThis[k]]));
  const beforeState = useStore.getState();
  Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,React,IS_REACT_ACT_ENVIRONMENT:true});
  dom.window.HTMLElement.prototype.attachEvent=function(){};
  dom.window.HTMLElement.prototype.detachEvent=function(){};
  const root=createRoot(document.querySelector('#root'));
  const fixtures=(project)=>({activeProjectId:project,portraitGroups:[{id:project+'-character',name:project+' Character'}],portraitAssets:[{id:project+'-face',groupId:project+'-character',name:project+' Face',imageUrl:'/api/media/face.png',role:'reference'}]});
  try {
    await act(async()=>{useStore.setState({portraitGalleryOpen:true,currentUser:{id:'actor1'},portraitAssetsLoading:false,loadAllPortraitAssets(){},...fixtures('A')});root.render(React.createElement(PortraitGallery));});
    const character=Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='A Character');
    await act(async()=>character.click());
    assert.equal(character.getAttribute('aria-pressed'),'true');
    await act(async()=>useStore.setState({portraitGalleryOpen:false}));
    await act(async()=>useStore.setState({portraitGalleryOpen:true}));
    assert.match(document.querySelector('h2').textContent,/A Character/);
    await act(async()=>useStore.setState({portraitGalleryOpen:false}));
    await act(async()=>useStore.setState(fixtures('B')));
    await act(async()=>useStore.setState({portraitGalleryOpen:true}));
    assert.match(document.querySelector('h2').textContent,/All characters/);
    assert.ok(document.querySelector('article[aria-label="B Face"]'));
    const b=Array.from(document.querySelectorAll('button')).find(x=>x.textContent==='B Character');
    await act(async()=>b.click());
    await act(async()=>useStore.setState({currentUser:{id:'actor2'}}));
    assert.match(document.querySelector('h2').textContent,/All characters/);
  } finally {
    await act(async()=>root.unmount());useStore.setState(beforeState,true);Object.assign(globalThis,beforeGlobals);dom.window.close();
  }
});
