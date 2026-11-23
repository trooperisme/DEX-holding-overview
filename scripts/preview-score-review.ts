// Offline, read-only replay. No production credentials, database, or upstream fetches.
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { holdingsSizeBonus, scoreFromComponents, SCORE_VERSION } from '../src/scoring';
import { withScoreTrajectories } from '../src/score-trajectory';
const folder = path.resolve(process.argv[2] || '.tmp/nov23');
const read = (file: string) => JSON.parse(fs.readFileSync(path.join(folder,file),'utf8'));
function rescore(row: any) {
 const c = {...row.scoreComponents,capital:row.scoreComponents.capital * holdingsSizeBonus(row.holdingsUsd)};
 const structuralScore = scoreFromComponents({...c,momentumMultiplier:1});
 return {...row,scoreComponents:c,score:scoreFromComponents(c),baseScore:structuralScore,structuralScore,scoreVersion:SCORE_VERSION};
}
const source = read('overview.json').rows;
const rows = source.map(rescore).sort((a:any,b:any)=>b.score-a.score || b.holdingsUsd-a.holdingsUsd);
const histories = new Map();
for(const file of fs.readdirSync(folder).filter(f=>/^history-.*\.json$/.test(f))) {
 const points=read(file).rows;
 if(points.length)histories.set(points[0].tokenKey,withScoreTrajectories(points.map(rescore)));
}
const app=express();
app.use((req,res,next)=> {res.set('Cache-Control','no-store');if(req.method!=='GET') {res.status(405).json({error:'Read-only snapshot replay'});return;}next();});
app.get('/api/snapshots',(_req,res)=>res.json({...read('snapshots.json'),snapshots:read('snapshots.json').snapshots.filter((s:any)=>s.id===164),latest:read('snapshots.json').snapshots.find((s:any)=>s.id===164)}));
app.get('/api/overview',(req,res)=> {
 if ((req.query.snapshotId && Number(req.query.snapshotId)!==164) || (req.query.minBalanceUsd && Number(req.query.minBalanceUsd)!==111) || (req.query.minSmwIn && Number(req.query.minSmwIn)!==1) || Number(req.query.maxMarketCapUsd || 0)>0) {res.status(400).json({error:'Offline preview includes only snapshot 164 with default filters'});return;}
 res.json({rows});
});
app.get('/api/favorite-entities',(_req,res)=>res.json(read('favorites.json')));
app.get('/api/refresh/status',(_req,res)=>res.json({job:null}));
app.get('/api/token-score-history',(req,res)=> {const points=histories.get(req.query.tokenKey); if(!points){res.status(404).json({error:'History not included in this offline review'});return;}const limit=Number(req.query.limit);res.json({rows:limit>0?points.slice(-limit):points});});
app.get('/api/token-holders',(_req,res)=>res.status(404).json({error:'Holder details not exported in this offline review'}));
app.get('/api/market-regime',(_req,res)=>res.json({regime:null}));
app.use('/api',(_req,res)=>res.status(404).json({error:'Not available in offline replay'}));
app.use('/dashboard',express.static(path.resolve('dashboard')));
app.get('/',(_req,res)=>res.redirect('/dashboard/'));
app.listen(3012,'127.0.0.1',()=>console.log('Offline Nov23 score review: http://127.0.0.1:3012/dashboard/'));
