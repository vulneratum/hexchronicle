// Loaded by tools/forge-export.js and inlined into World Forge; generateWorld comes from gen.js.
var generateWorld=(typeof generateWorld!=='undefined')?generateWorld:require('./gen.js').generateWorld;
// Two continents: the kept western world (unchanged) and a new eastern continent
// joined across a narrow strait. Composite grid uses 3-mile cells, top = 57°N.
function generateTwoContinents(PW,PE,progress){
  progress=progress||function(){};
  const CPD=69.1/3;                         // cells per degree of latitude
  const LAT_TOP=57,LAT_BOT=35,HT=Math.round((LAT_TOP-LAT_BOT)*CPD);
  progress('Western continent: raising the land');
  const O=generateWorld(Object.assign({},PW,{W:432,H:360}),function(m){progress('Western continent: '+m.toLowerCase());});
  const oy=Math.round((LAT_TOP-55)*CPD);    // the kept world spans 55°N downward
  // old land extent in composite coordinates
  let oldMaxX=0,narrowY=0;const coastX=new Int32Array(HT).fill(-1);
  for(let y=0;y<O.H;y++)for(let x=0;x<O.W;x++){const i=y*O.W+x;if(O.ocean[i])continue;const cy=y+oy;if(x>coastX[cy])coastX[cy]=x;if(x>oldMaxX){oldMaxX=x;narrowY=cy;}}
  const xE0=oldMaxX-70,WE=PE.width||1700,WT=xE0+WE;
  // distance (cells) from old land, chamfer over the east grid
  const INF=1e9,dist=new Float32Array(WE*HT).fill(INF);
  for(let y=0;y<HT;y++)for(let x=0;x<WE;x++){const cx=x+xE0,oyy=y-oy;if(cx<O.W&&oyy>=0&&oyy<O.H&&!O.ocean[oyy*O.W+cx])dist[y*WE+x]=0;
    else if(x===0&&coastX[y]>=xE0)dist[y*WE]=0;}
  const D1=1,D2=Math.SQRT2;
  for(let y=0;y<HT;y++)for(let x=0;x<WE;x++){const i=y*WE+x;let d=dist[i];
    if(x>0)d=Math.min(d,dist[i-1]+D1);if(y>0){d=Math.min(d,dist[i-WE]+D1);if(x>0)d=Math.min(d,dist[i-WE-1]+D2);if(x<WE-1)d=Math.min(d,dist[i-WE+1]+D2);}dist[i]=d;}
  for(let y=HT-1;y>=0;y--)for(let x=WE-1;x>=0;x--){const i=y*WE+x;let d=dist[i];
    if(x<WE-1)d=Math.min(d,dist[i+1]+D1);if(y<HT-1){d=Math.min(d,dist[i+WE]+D1);if(x<WE-1)d=Math.min(d,dist[i+WE+1]+D2);if(x>0)d=Math.min(d,dist[i+WE-1]+D2);}dist[i]=d;}
  const minGap=PE.minGap||10, reach=PE.reach||17;     // 30 mi floor; narrows pulled to ~50 mi
  let ph=0;for(const ch of String(PE.seed))ph=(ph*31+ch.charCodeAt(0))%6283;ph/=1000;
  const band=Math.ceil(CPD),force=new Uint8Array(WE*HT),bias=new Float32Array(WE*HT);
  for(let y=0;y<HT;y++)for(let x=0;x<WE;x++){const i=y*WE+x,cx=x+xE0;
    if(dist[i]<minGap||cx<oldMaxX-30||y<band||y>=HT-band)force[i]=1;
    { // a land arm reaching west from the main continent to the narrows
      const x0=oldMaxX+reach,ramp=cx>=x0?1:Math.exp(-((cx-x0)**2)/(8*8)),fade=cx<x0+420?1:Math.exp(-((cx-x0-420)**2)/(120*120));
      const yc=narrowY+22*Math.sin(cx/41+ph)+10*Math.sin(cx/15+2*ph),wd=44+16*Math.sin(cx/29+3*ph);bias[i]=1.25*ramp*fade*Math.exp(-((y-yc)**2)/(wd*wd));}}
  const target=Math.round((PE.areaSqMi||3933000)/9);
  const PE2=Object.assign({},PE,{W:WE,H:HT,latTop:LAT_TOP,latSpan:LAT_TOP-LAT_BOT,edgeCells:24,noWest:true,warp:HT/9.5,
    forceOcean:force,bias,landCellsTarget:target,contFactor:1.1,recycle:0.72,edgeVar:70,coast:(PE.coast==null?1.2:PE.coast)*1.35,lakeDepth:0.008,land:Math.min(80,target/(WE*HT)*100*1.02),lakes:(PE.lakes==null?1:PE.lakes)*0.6});
  const E=generateWorld(PE2,function(m){progress('Eastern continent: '+m.toLowerCase());});
  progress('Joining the two continents');
  const N=WT*HT,ft=new Float32Array(N).fill(-9000),rain=new Float32Array(N),temp=new Float32Array(N),biome=new Uint8Array(N),ocean=new Uint8Array(N).fill(1),lake=new Uint8Array(N),cont=new Uint8Array(N);
  for(let y=0;y<HT;y++)for(let x=0;x<WT;x++){const i=y*WT+x;
    const oyy=y-oy,ex=x-xE0;let src=null,j=-1;
    const inO=x<O.W&&oyy>=0&&oyy<O.H,inE=ex>=0&&ex<WE;
    if(inO){const k=oyy*O.W+x;if(!O.ocean[k]){src=O;j=k;cont[i]=1;}}
    if(!src&&inE){const k=y*WE+ex;if(!E.ocean[k]){src=E;j=k;cont[i]=2;}}
    if(!src){if(inE){src=E;j=y*WE+ex;}else if(inO){src=O;j=oyy*O.W+x;}}
    if(!src){ // open sea outside both grids
      const lat=LAT_TOP-(y+0.5)/HT*(LAT_TOP-LAT_BOT);temp[i]=47+(55-lat);rain[i]=30;continue;}
    ft[i]=src.ft[j];rain[i]=src.rain[j];temp[i]=src.temp[j];biome[i]=src.biome[j];ocean[i]=src.ocean[j];lake[i]=src.lake[j];
  }
  // measure the strait: shortest sea crossing between the two coasts
  const comp=new Int32Array(N).fill(-1),sizes=[];{const st=new Int32Array(N);for(let s0=0;s0<N;s0++){if(ocean[s0]||comp[s0]>=0)continue;const id=sizes.length;let top=0,n=0;st[top++]=s0;comp[s0]=id;
    while(top){const i=st[--top];n++;const x=i%WT,y=(i-x)/WT;for(const j of [x>0?i-1:-1,x<WT-1?i+1:-1,y>0?i-WT:-1,y<HT-1?i+WT:-1]){if(j<0||ocean[j]||comp[j]>=0)continue;comp[j]=id;st[top++]=j;}}sizes.push(n);}}
  let mW=-1,mE=-1,bW=0,bE=0;for(let i=0;i<N;i++){const c=comp[i];if(c<0)continue;if(cont[i]===1&&sizes[c]>bW){bW=sizes[c];mW=c;}if(cont[i]===2&&sizes[c]>bE){bE=sizes[c];mE=c;}}
  let gap=INF;{const d=new Float32Array(N).fill(INF);for(let i=0;i<N;i++)if(comp[i]===mW)d[i]=0;
    for(let y=0;y<HT;y++)for(let x=0;x<WT;x++){const i=y*WT+x;let v=d[i];if(x>0)v=Math.min(v,d[i-1]+1);if(y>0){v=Math.min(v,d[i-WT]+1);if(x>0)v=Math.min(v,d[i-WT-1]+D2);if(x<WT-1)v=Math.min(v,d[i-WT+1]+D2);}d[i]=v;}
    for(let y=HT-1;y>=0;y--)for(let x=WT-1;x>=0;x--){const i=y*WT+x;let v=d[i];if(x<WT-1)v=Math.min(v,d[i+1]+1);if(y<HT-1){v=Math.min(v,d[i+WT]+1);if(x<WT-1)v=Math.min(v,d[i+WT+1]+D2);if(x>0)v=Math.min(v,d[i+WT-1]+D2);}d[i]=v;}
    for(let i=0;i<N;i++)if(comp[i]===mE&&d[i]<gap)gap=d[i];}
  let landW=0,landE=0;for(let i=0;i<N;i++){if(cont[i]===1)landW++;else if(cont[i]===2)landE++;}
  let pk=0;for(let i=0;i<N;i++)if(!ocean[i]&&!lake[i]&&ft[i]>pk)pk=ft[i];
  return {W:WT,H:HT,ft,rain,temp,biome,ocean,lake,cont,
    origin:[O.W*1.5,(oy+O.H/2)*3],       // the kept world's centre, so its hexes land where they always did
    latTop:LAT_TOP,latBot:LAT_BOT,
    stats:{westSqMi:landW*9,eastSqMi:landE*9,landSqMi:(landW+landE)*9,peakFt:Math.round(pk),straitMi:Math.round(Math.max(0,gap-1)*3),westPeak:O.stats.peakFt,eastPeak:E.stats.peakFt}};
}
if(typeof module!=='undefined')module.exports={generateTwoContinents};
