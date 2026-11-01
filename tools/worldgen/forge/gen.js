// HexChronicle World Forge — generator core (no DOM). Runs in a Web Worker or Node.
function hashStr(s){let h=1779033703^s.length;for(let i=0;i<s.length;i++){h=Math.imul(h^s.charCodeAt(i),3432918353);h=h<<13|h>>>19;}h=Math.imul(h^h>>>16,2246822507);h=Math.imul(h^h>>>13,3266489909);return (h^h>>>16)>>>0;}
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
function makeSimplex(rng){
  const p=new Uint8Array(256);for(let i=0;i<256;i++)p[i]=i;
  for(let i=255;i>0;i--){const j=Math.floor(rng()*(i+1));const t=p[i];p[i]=p[j];p[j]=t;}
  const perm=new Uint8Array(512),pm12=new Uint8Array(512);
  for(let i=0;i<512;i++){perm[i]=p[i&255];pm12[i]=perm[i]%12;}
  const g=[1,1,-1,1,1,-1,-1,-1,1,0,-1,0,1,0,-1,0,0,1,0,-1,0,1,0,-1];
  const F2=0.5*(Math.sqrt(3)-1),G2=(3-Math.sqrt(3))/6;
  return function(xin,yin){
    let n0=0,n1=0,n2=0;const s=(xin+yin)*F2;const i=Math.floor(xin+s),j=Math.floor(yin+s);
    const t=(i+j)*G2;const x0=xin-(i-t),y0=yin-(j-t);let i1,j1;if(x0>y0){i1=1;j1=0;}else{i1=0;j1=1;}
    const x1=x0-i1+G2,y1=y0-j1+G2,x2=x0-1+2*G2,y2=y0-1+2*G2;const ii=i&255,jj=j&255;
    let t0=0.5-x0*x0-y0*y0;if(t0>0){const gi=pm12[ii+perm[jj]]*2;t0*=t0;n0=t0*t0*(g[gi]*x0+g[gi+1]*y0);}
    let t1=0.5-x1*x1-y1*y1;if(t1>0){const gi=pm12[ii+i1+perm[jj+j1]]*2;t1*=t1;n1=t1*t1*(g[gi]*x1+g[gi+1]*y1);}
    let t2=0.5-x2*x2-y2*y2;if(t2>0){const gi=pm12[ii+1+perm[jj+1]]*2;t2*=t2;n2=t2*t2*(g[gi]*x2+g[gi+1]*y2);}
    return 70*(n0+n1+n2);
  };
}
function fbm(nf,x,y,oct){let a=1,f=1,s=0,n=0;for(let o=0;o<oct;o++){s+=a*nf(x*f,y*f);n+=a;a*=0.5;f*=2.03;}return s/n;}
function ridged(nf,x,y,oct){let a=1,f=1,s=0,n=0;for(let o=0;o<oct;o++){let v=1-Math.abs(nf(x*f,y*f));v*=v;s+=a*v;n+=a;a*=0.5;f*=2.03;}return s/n;}
const gauss=(d,w)=>Math.exp(-(d*d)/(w*w));
const smooth=(a,b,x)=>{let t=(x-a)/(b-a);t=t<0?0:t>1?1:t;return t*t*(3-2*t);};

class Heap{constructor(n){this.k=new Float32Array(n);this.v=new Int32Array(n);this.n=0;}
  push(key,val){let i=this.n++;const k=this.k,v=this.v;while(i>0){const p=(i-1)>>1;if(k[p]<=key)break;k[i]=k[p];v[i]=v[p];i=p;}k[i]=key;v[i]=val;}
  pop(){const k=this.k,v=this.v;const top=v[0];const n=--this.n;if(n>0){const key=k[n],val=v[n];let i=0;for(;;){let c=2*i+1;if(c>=n)break;if(c+1<n&&k[c+1]<k[c])c++;if(k[c]>=key)break;k[i]=k[c];v[i]=v[c];i=c;}k[i]=key;v[i]=val;}return top;}}

const BIOMES=['ocean','water','plains','savanna','scrub','forest','taiga','jungle','swamp','hills','badlands','desert','mountains','tundra','glacier'];

function generateWorld(P,progress){
  progress=progress||function(){};
  const W=P.W||432,H=P.H||360,N=W*H;
  const rng=mulberry32(hashStr(String(P.seed)));
  const nA=makeSimplex(rng),nB=makeSimplex(rng),nC=makeSimplex(rng),nD=makeSimplex(rng),nE=makeSimplex(rng);
  const DX=[1,-1,0,0,1,1,-1,-1],DY=[0,0,1,-1,1,-1,1,-1],DD=[1,1,1,1,Math.SQRT2,Math.SQRT2,Math.SQRT2,Math.SQRT2];

  // ---------- 1. Tectonic plates ----------
  progress('Placing tectonic plates',0.02);
  const NP=P.plates;const px=[],py=[],vx=[],vy=[];
  for(let k=0;k<NP;k++){
    let best=null,bd=-1;
    for(let c=0;c<10;c++){const x=rng()*W,y=rng()*H;let m=1e9;for(let j=0;j<k;j++){const d=(x-px[j])**2+(y-py[j])**2;if(d<m)m=d;}if(m>bd){bd=m;best=[x,y];}}
    px.push(best[0]);py.push(best[1]);const a=rng()*Math.PI*2,s=0.35+0.65*rng();vx.push(Math.cos(a)*s);vy.push(Math.sin(a)*s);
  }
  const plate=new Uint8Array(N),plate2=new Uint8Array(N),bdist=new Float32Array(N);
  const WA=P.warp||W/9.5,wf=1/120;
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){
    const wx=x+WA*fbm(nA,x*wf,y*wf,4),wy=y+WA*fbm(nB,x*wf+31.7,y*wf-12.3,4);
    let d1=1e12,d2=1e12,k1=0,k2=0;
    for(let k=0;k<NP;k++){const d=(wx-px[k])**2+(wy-py[k])**2;if(d<d1){d2=d1;k2=k1;d1=d;k1=k;}else if(d<d2){d2=d;k2=k;}}
    const i=y*W+x;plate[i]=k1;plate2[i]=k2;
    const sep=Math.hypot(px[k1]-px[k2],py[k1]-py[k2])||1;bdist[i]=(d2-d1)/(2*sep);
  }
  const area=new Float64Array(NP);const adj=[];for(let k=0;k<NP;k++)adj.push(new Set());
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){const i=y*W+x;area[plate[i]]++;
    if(x+1<W&&plate[i+1]!==plate[i]){adj[plate[i]].add(plate[i+1]);adj[plate[i+1]].add(plate[i]);}
    if(y+1<H&&plate[i+W]!==plate[i]){adj[plate[i]].add(plate[i+W]);adj[plate[i+W]].add(plate[i]);}}
  // grow one continent outward from the centre
  const cont=new Uint8Array(NP);const cx=W/2,cy=H/2;
  let seedK=0,sd=1e12;for(let k=0;k<NP;k++){const d=(px[k]-cx)**2+(py[k]-cy)**2;if(d<sd){sd=d;seedK=k;}}
  cont[seedK]=1;let landA=area[seedK];const target=P.land/100*N*(P.contFactor||1.3);
  const jitter=new Float64Array(NP);for(let k=0;k<NP;k++)jitter[k]=rng();
  while(landA<target){
    let bestK=-1,bs=1e9;
    for(let k=0;k<NP;k++){if(cont[k])continue;let touch=false;for(const j of adj[k])if(cont[j]){touch=true;break;}if(!touch)continue;
      const ex=Math.min(px[k],W-px[k])/W,ey=Math.min(py[k],H-py[k])/H;
      const s=Math.hypot((px[k]-cx)/W,(py[k]-cy)/H)*2+(Math.min(ex,ey)<0.13?1.5:0)+jitter[k]*0.7;if(s<bs){bs=s;bestK=k;}}
    if(bestK<0)break;cont[bestK]=1;landA+=area[bestK];
  }
  const baseH=[];for(let k=0;k<NP;k++)baseH.push(cont[k]?0.22+0.08*rng():-0.5-0.15*rng());

  // ---------- 2. Heights from plate motion ----------
  progress('Raising mountains at plate collisions',0.12);
  const h=new Float32Array(N),U=new Float32Array(N);const mtn=P.mtn,coast=P.coast;
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){
    const i=y*W+x,k1=plate[i],k2=plate2[i],b=bdist[i];
    const t=smooth(0,1,0.5+b/24);
    let e=baseH[k2]+(baseH[k1]-baseH[k2])*t;
    let nx=px[k2]-px[k1],ny=py[k2]-py[k1];const nl=Math.hypot(nx,ny)||1;nx/=nl;ny/=nl;
    const rx=vx[k1]-vx[k2],ry=vy[k1]-vy[k2];const conv=rx*nx+ry*ny,shear=Math.abs(rx*ny-ry*nx);
    const c1=cont[k1],c2=cont[k2];
    const mod=0.25+1.05*ridged(nC,x/34,y/34,4);
    let up=0;
    if(conv>0){
      if(c1&&c2)up+=conv*0.95*gauss(b,16)*mod;
      else if(c1&&!c2)up+=conv*0.8*gauss(b-9,8)*mod;
      else if(!c1&&c2){up+=conv*0.15*gauss(b,4)*mod;e-=conv*0.12*gauss(b,3);}
      else up+=conv*0.5*gauss(b,4)*mod;
    }else{
      const dv=-conv;
      if(c1&&c2){e-=dv*0.28*gauss(b,7);up+=dv*0.1*gauss(b-11,5)*mod;}
      else if(!c1&&!c2)up+=dv*0.08*gauss(b,3);
    }
    up+=shear*0.14*gauss(b,6)*mod;
    up*=mtn;
    const cf=c1*t+c2*(1-t);
    e+=cf*0.07*ridged(nD,x/20+40,y/20,3)*mtn;          // worn ancient uplands
    e+=0.10*fbm(nD,x/75+100,y/75,5);                    // broad swells
    {const qx=x+14*fbm(nB,x/30,y/30,3),qy=y+14*fbm(nC,x/30+7,y/30+3,3);
    e+=coast*(0.09*fbm(nE,qx/42+50,qy/42+50,3)+0.10*fbm(nE,qx/13-20,qy/13+80,5));}            // coastline roughness (warped)
    e+=up;U[i]=up;
    if(P.bias)e+=P.bias[i];
    let ed,m;
    if(P.edgeCells){m=P.edgeCells+(P.edgeVar||0)*Math.max(0,fbm(nA,x/110+17,y/110-5,4)+0.25);ed=Math.min(P.noWest?1e9:x,W-1-x,y,H-1-y)+P.edgeCells*0.4*nA(x/45+9,y/45-9);}
    else{ed=Math.min(x,W-1-x,y,H-1-y)/Math.min(W,H)+0.035*nA(x/45+9,y/45-9);m=0.13;}
    if(ed<m){const f=smooth(0,m,ed);e=e*f-0.6*(1-f);}
    if(P.forceOcean&&P.forceOcean[i])e=Math.min(e,-0.45);
    h[i]=e;
  }
  {const s=Float32Array.from(h).sort();const thr=s[Math.floor(N*(1-P.land/100))];for(let i=0;i<N;i++)h[i]-=thr;}

  // ---------- 3. Climate ----------
  const LT=P.latTop||55,LS=P.latSpan||15.6,RC=P.recycle||0;
  function climate(hh){
    const temp=new Float32Array(N),rain=new Float32Array(N);
    for(let y=0;y<H;y++){const lat=LT-y/H*LS,T0=47+(55-lat);for(let x=0;x<W;x++){const i=y*W+x;temp[i]=T0-Math.max(0,hh[i])*10000*0.003+1.5*nB(x/60,y/60);}}
    const slopes=[0,-0.22,0.22,-0.45,0.45],wts=[1.4,1,1,0.6,0.6];let wsum=0;
    for(let s=0;s<slopes.length;s++){const sl=slopes[s];wsum+=wts[s];const span=Math.ceil(Math.abs(sl)*W);
      for(let y0=-span;y0<H+span;y0++){let M=1,pf=0;
        for(let x=0;x<W;x++){const y=Math.round(y0+x*sl);if(y<0||y>=H)continue;const i=y*W+x;
          if(hh[i]<=0){M+=(1-M)*0.12;pf=0;rain[i]+=wts[s]*M*0.02;continue;}
          const f=hh[i]*10000;const up=Math.max(0,f-pf)/1000;pf=f;
          let r=M*(0.03+0.07*up);if(r>M*0.5)r=M*0.5;M-=r*0.28*(1-RC);
          rain[i]+=wts[s]*r;}}}
    for(let i=0;i<N;i++)rain[i]/=wsum;
    const tmp=new Float32Array(N);
    for(let pass=0;pass<3;pass++){for(let y=0;y<H;y++)for(let x=0;x<W;x++){let s=0,c=0;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const xx=x+dx,yy=y+dy;if(xx<0||yy<0||xx>=W||yy>=H)continue;s+=rain[yy*W+xx];c++;}tmp[y*W+x]=s/c;}rain.set(tmp);}
    for(let y=0;y<H;y++){const lat=LT-y/H*LS;const lf=0.62+0.55*(lat-39.4)/15.6;for(let x=0;x<W;x++){const i=y*W+x;rain[i]=(6+rain[i]*1500)*lf*P.wet*(1+0.2*fbm(nE,x/70,y/70,3));}}
    return {temp,rain};
  }

  // ---------- 4. Drainage + erosion ----------
  const rec=new Int32Array(N),order=new Int32Array(N),A=new Float32Array(N);let cnt=0;
  function flood(hh,sea){
    const done=new Uint8Array(N);const heap=new Heap(N);cnt=0;
    for(let y=0;y<H;y++)for(let x=0;x<W;x++){const i=y*W+x;if(hh[i]>sea)continue;done[i]=1;rec[i]=i;
      let edge=x===0||y===0||x===W-1||y===H-1;if(!edge)for(let d=0;d<8;d++){if(hh[i+DX[d]+DY[d]*W]>sea){edge=true;break;}}if(edge)heap.push(hh[i],i);}
    for(let y=0;y<H;y++)for(let x=0;x<W;x++){if(x&&y&&x<W-1&&y<H-1)continue;const i=y*W+x;if(!done[i]){done[i]=1;rec[i]=i;heap.push(hh[i],i);}}
    while(heap.n){const c=heap.pop();const cx_=c%W,cy_=(c-cx_)/W;
      for(let d=0;d<8;d++){const xx=cx_+DX[d],yy=cy_+DY[d];if(xx<0||yy<0||xx>=W||yy>=H)continue;const nb=yy*W+xx;if(done[nb])continue;done[nb]=1;
        if(hh[nb]<=hh[c]+1e-5)hh[nb]=hh[c]+1e-5;rec[nb]=c;order[cnt++]=nb;heap.push(hh[nb],nb);}}
  }
  function accumulate(rn){for(let i=0;i<N;i++)A[i]=rn[i];for(let j=cnt-1;j>=0;j--){const i=order[j];const r=rec[i];if(r!==i)A[r]+=A[i];}}
  let clim=climate(h);
  const iters=P.erosion;
  let meanR=0;for(let i=0;i<N;i++)meanR+=clim.rain[i];meanR/=N;
  const rn=new Float32Array(N);for(let i=0;i<N;i++)rn[i]=clim.rain[i]/meanR;
  const tmpH=new Float32Array(N);
  for(let it=0;it<iters;it++){
    if(it%5===0)progress('Carving river valleys',0.25+0.55*it/Math.max(1,iters));
    if(it===Math.floor(iters/2)){clim=climate(h);for(let i=0;i<N;i++)rn[i]=clim.rain[i]/meanR;}
    flood(h,0);accumulate(rn);
    for(let j=0;j<cnt;j++){const i=order[j],r=rec[i];const dxy=(Math.abs(i-r)===1||Math.abs(i-r)===W)?1:Math.SQRT2;
      const f=0.0045*Math.sqrt(A[i])/dxy;h[i]=(h[i]+f*h[r])/(1+f);}
    for(let i=0;i<N;i++)if(h[i]>0)h[i]+=U[i]*0.012;
    if(P.forceOcean)for(let i=0;i<N;i++)if(P.forceOcean[i]&&h[i]>-0.02)h[i]=-0.02;
    tmpH.set(h);
    for(let y=1;y<H-1;y++)for(let x=1;x<W-1;x++){const i=y*W+x;if(tmpH[i]<=0)continue;const avg=(tmpH[i-1]+tmpH[i+1]+tmpH[i-W]+tmpH[i+W])*0.25;h[i]+=0.12*(avg-tmpH[i]);if(h[i]<0.0005)h[i]=0.0005;}
  }

  // ---------- 5. Lakes, final drainage ----------
  progress('Filling lakes and tracing rivers',0.82);
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){const i=y*W+x;if(h[i]>0.003){const v=fbm(nA,x/26+300,y/26,3);if(v>0.32)h[i]-=(v-0.32)*0.012*P.lakes;}}
  let sea=P.sea*0.006;
  if(P.landCellsTarget){ // settle sea level so the continent has exactly the asked-for area
    const oc=new Uint8Array(N),st=new Int32Array(N*4+8);
    const landAt=s=>{oc.fill(0);let n=0,top=0;for(let x=0;x<W;x++){st[top++]=x;st[top++]=(H-1)*W+x;}for(let y=0;y<H;y++){st[top++]=y*W;st[top++]=y*W+W-1;}
      while(top){const i=st[--top];if(oc[i]||h[i]>s)continue;oc[i]=1;n++;const x=i%W,y=(i-x)/W;if(x>0)st[top++]=i-1;if(x<W-1)st[top++]=i+1;if(y>0)st[top++]=i-W;if(y<H-1)st[top++]=i+W;}
      return N-n;};
    let lo=-0.08,hi=0.12;for(let k=0;k<26;k++){const mid=(lo+hi)/2;if(landAt(mid)>P.landCellsTarget)lo=mid;else hi=mid;}sea=(lo+hi)/2;
  }
  const hb=Float32Array.from(h);const hf=Float32Array.from(h);
  flood(hf,sea);
  clim=climate(hb);
  const rainN=new Float32Array(N);for(let i=0;i<N;i++)rainN[i]=hb[i]>sea?clim.rain[i]/40:0;
  accumulate(rainN);
  // ocean = below sea level & connected to map edge
  const ocean=new Uint8Array(N);{const st=[];for(let x=0;x<W;x++){st.push(x,(H-1)*W+x);}for(let y=0;y<H;y++){st.push(y*W,y*W+W-1);}
    while(st.length){const i=st.pop();if(ocean[i]||hb[i]>sea)continue;ocean[i]=1;const x=i%W,y=(i-x)/W;if(x>0)st.push(i-1);if(x<W-1)st.push(i+1);if(y>0)st.push(i-W);if(y<H-1)st.push(i+W);}}
  const lake=new Uint8Array(N);
  for(let i=0;i<N;i++){if(ocean[i])continue;if(P.landCellsTarget){if(hb[i]<=sea)hb[i]=sea+0.0002;if(hf[i]-hb[i]>(P.lakeDepth||0.004))lake[i]=1;}else if(hb[i]<=sea||hf[i]-hb[i]>0.004)lake[i]=1;}
  // drop single-cell lake specks
  for(let y=1;y<H-1;y++)for(let x=1;x<W-1;x++){const i=y*W+x;if(!lake[i])continue;let n=0;for(let d=0;d<8;d++)n+=lake[i+DX[d]+DY[d]*W];if(n===0)lake[i]=0;}

  // ---------- 6. Biomes ----------
  progress('Assigning terrain',0.92);
  const ft=new Float32Array(N),biome=new Uint8Array(N);
  let maxLand=0;for(let i=0;i<N;i++)if(!ocean[i]&&hb[i]>maxLand)maxLand=hb[i];
  const peak=7000+P.mtn*5500;
  for(let i=0;i<N;i++){ft[i]=ocean[i]?Math.min(-30,(hb[i]-sea)*12000):lake[i]?(hf[i]-sea)/maxLand*peak:Math.max(5,(hb[i]-sea)/maxLand*peak);}
  clim=climate(Float32Array.from(ft,v=>v/10000));
  const temp=clim.temp,rain=clim.rain;
  let flowSwamp;{const fl=[];for(let i=0;i<N;i++)if(!ocean[i]&&!lake[i])fl.push(A[i]);fl.sort((a,b)=>a-b);flowSwamp=fl[Math.floor(fl.length*0.975)]||1;}
  const counts=new Array(15).fill(0);
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){const i=y*W+x;let b;
    if(ocean[i])b=0;else if(lake[i])b=1;else{
      let sl=0;for(let d=0;d<4;d++){const xx=x+DX[d],yy=y+DY[d];if(xx<0||yy<0||xx>=W||yy>=H)continue;const j=yy*W+xx;if(ocean[j])continue;const v=Math.abs(ft[j]-ft[i]);if(v>sl)sl=v;}
      const T=temp[i],R=rain[i],f=ft[i];
      if(T<20)b=14;
      else if(f>5200||(f>3800&&sl>1000))b=(T<29&&sl<1400)?13:12;
      else if(f>2300||sl>520)b=R<15?10:9;
      else if(R<10)b=11;
      else if(A[i]>flowSwamp&&sl<90&&f<500&&R>26)b=8;
      else if(T>60&&R>60)b=7;
      else if(R<15)b=4;
      else if(R<21&&T>56)b=3;
      else if(R>=31)b=T<44?6:5;
      else b=2;
    }
    biome[i]=b;counts[b]++;}
  // stats
  let landCells=0;for(let i=0;i<N;i++)if(!ocean[i])landCells++;
  let pk=0,pkI=0;for(let i=0;i<N;i++)if(!ocean[i]&&!lake[i]&&ft[i]>pk){pk=ft[i];pkI=i;}
  progress('Done',1);
  return {W,H,ft,rain,temp,biome,flow:A,rec,ocean,lake,plate,cont:Array.from(cont),px,py,vx,vy,
    stats:{landCells,landSqMi:landCells*9,peakFt:Math.round(pk),peakX:pkI%W,peakY:Math.floor(pkI/W),counts,flowSwamp}};
}
if(typeof module!=='undefined')module.exports={generateWorld,BIOMES};
