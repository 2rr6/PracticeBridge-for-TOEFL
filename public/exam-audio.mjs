// Schedule the audio boundary ahead of time, independently of render callbacks.
// The accepted WAV is also capped by decoded sample frames, not a duration label.
export async function createRecordingGate(stream, seconds) {
  if(!Number.isFinite(seconds)||seconds<=0)throw new Error('本次回答时间已用完。');
  const context=new AudioContext();
  try{
    await context.resume();
    const source=context.createMediaStreamSource(stream),gain=context.createGain(),destination=context.createMediaStreamDestination();
    const start=context.currentTime;
    gain.gain.setValueAtTime(1,start);gain.gain.setValueAtTime(0,start+seconds);
    source.connect(gain);gain.connect(destination);
    return {context,stream:destination.stream,close:async()=>{destination.stream.getTracks().forEach(track=>track.stop());await context.close().catch(()=>{});}};
  }catch(error){await context.close().catch(()=>{});throw error;}
}

export function audioBufferToWav(buffer,maxSeconds) {
  const frames=Math.min(buffer.length,Math.floor(maxSeconds*buffer.sampleRate));
  if(!Number.isSafeInteger(frames)||frames<=0)throw new Error('录音中没有可保存的音频帧。');
  const bytes=new ArrayBuffer(44+frames*2),view=new DataView(bytes);
  const text=(offset,value)=>[...value].forEach((char,index)=>view.setUint8(offset+index,char.charCodeAt(0)));
  text(0,'RIFF');view.setUint32(4,36+frames*2,true);text(8,'WAVE');text(12,'fmt ');view.setUint32(16,16,true);
  view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,buffer.sampleRate,true);view.setUint32(28,buffer.sampleRate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,frames*2,true);
  const channels=Array.from({length:buffer.numberOfChannels},(_,i)=>buffer.getChannelData(i));
  for(let frame=0;frame<frames;frame++){
    const sample=Math.max(-1,Math.min(1,channels.reduce((sum,channel)=>sum+channel[frame],0)/channels.length));
    view.setInt16(44+frame*2,Math.round(sample*(sample<0?32768:32767)),true);
  }
  return new Blob([bytes],{type:'audio/wav'});
}

export async function capRecordingBlob(blob,maxSeconds,context) {
  const ownContext=!context,decoder=context||new AudioContext();
  try{return audioBufferToWav(await decoder.decodeAudioData(await blob.arrayBuffer()),maxSeconds);}
  finally{if(ownContext)await decoder.close().catch(()=>{});}
}
