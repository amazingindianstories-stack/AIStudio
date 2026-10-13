import test from 'node:test';
import assert from 'node:assert/strict';
import { useStore } from './store';

test('store moves duplicate occurrences without moving another source metadata', () => {
  const previous=useStore.getState();
  try {
    useStore.setState({referenceImages:[],referenceIds:[],referenceKinds:[],referenceTags:[],referenceLabels:[],referenceVideos:[],referenceAudios:[],audioNotes:[],prompt:'@img1 @img2 @img10 @img2x @slug'});
    useStore.getState().addReference('/api/media/same','image','first');
    useStore.getState().addReference('/api/media/same','portrait','second','@slug');
    const before=[...useStore.getState().referenceIds];
    useStore.getState().moveReference({id:before[1],toIndex:0});
    assert.deepEqual(useStore.getState().referenceIds,[before[1],before[0]]);
    assert.deepEqual(useStore.getState().referenceLabels,['second','first']);
    assert.equal(useStore.getState().prompt,'@img2 @img1 @img10 @img2x @slug');
    useStore.getState().undoReferenceReorder();
    assert.deepEqual(useStore.getState().referenceIds,before);
    assert.equal(useStore.getState().prompt,'@img1 @img2 @img10 @img2x @slug');
  } finally {useStore.setState(previous,true);}
});

test('audio references persist in canonical sequence and total staging cap is atomic', () => {
  const previous=useStore.getState();
  try {
    useStore.setState({referenceImages:[],referenceIds:[],referenceKinds:[],referenceTags:[],referenceLabels:[],referenceVideos:[],referenceAudios:[],audioNotes:[]});
    useStore.getState().addAudioNote({name:'voice',ref:'/api/media/audio'});
    assert.deepEqual(useStore.getState().referenceAudios,['/api/media/audio']);
    for(let i=0;i<49;i++) useStore.getState().addReference(`/api/media/image-${i}`);
    useStore.getState().addReference('/api/media/too-many');
    assert.equal(useStore.getState().referenceImages.length,49);
    assert.match(useStore.getState().draftStorageWarning,/50/);
    useStore.getState().removeAudioNote(0);
    assert.deepEqual(useStore.getState().referenceAudios,[]);
    useStore.getState().addReference('/api/media/last');
    assert.equal(useStore.getState().referenceImages.length,50);
  } finally {useStore.setState(previous,true);}
});
