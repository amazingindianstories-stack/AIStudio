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
    // Tags are positional: a reorder never rewrites the typed prompt.
    assert.equal(useStore.getState().prompt,'@img1 @img2 @img10 @img2x @slug');
    useStore.getState().undoReferenceReorder();
    assert.deepEqual(useStore.getState().referenceIds,before);
    assert.deepEqual(useStore.getState().referenceLabels,['first','second']);
    assert.equal(useStore.getState().prompt,'@img1 @img2 @img10 @img2x @slug');
  } finally {useStore.setState(previous,true);}
});

test('reordering and removing references never rewrite the prompt, as in Higgsfield', () => {
  const previous=useStore.getState();
  const prompt='@img1 then @IMG3 and @img2, not @img30 @slug';
  try {
    useStore.setState({referenceImages:[],referenceIds:[],referenceKinds:[],referenceTags:[],referenceLabels:[],referenceVideos:[],referenceAudios:[],audioNotes:[],prompt});
    for (const label of ['a','b','c']) useStore.getState().addReference(`/api/media/${label}`,'image',label);
    const [a,b,c]=useStore.getState().referenceIds;
    useStore.getState().reorderReferencesByIds([b,c,a]);
    assert.deepEqual(useStore.getState().referenceLabels,['b','c','a']);
    assert.equal(useStore.getState().prompt,prompt);
    useStore.getState().moveReference({id:a,toIndex:0});
    assert.deepEqual(useStore.getState().referenceLabels,['a','b','c']);
    assert.equal(useStore.getState().prompt,prompt);
    useStore.getState().reorderReferences(['/api/media/c','/api/media/a','/api/media/b']);
    assert.deepEqual(useStore.getState().referenceLabels,['c','a','b']);
    assert.equal(useStore.getState().prompt,prompt);
    useStore.getState().undoReferenceReorder();
    assert.deepEqual(useStore.getState().referenceIds,[a,b,c]);
    assert.equal(useStore.getState().prompt,prompt);
    assert.equal(useStore.getState().referenceReorderUndo,null);
    // Removing slot 2 closes the strip up and leaves every tag's number alone: @img2 now names
    // image c and @IMG3 points past the last slot until it is replaced or a third reference lands.
    useStore.getState().removeReference(1);
    assert.deepEqual(useStore.getState().referenceLabels,['a','c']);
    assert.equal(useStore.getState().prompt,prompt);
    useStore.getState().addReference('/api/media/d','image','d');
    assert.deepEqual(useStore.getState().referenceLabels,['a','c','d']);
    assert.equal(useStore.getState().prompt,prompt);
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
