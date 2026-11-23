import fs from 'node:fs';
import { holdingsSizeBonus, scoreFromComponents } from '../src/scoring';
const folder = process.argv[2] || '.tmp/nov23';
const rows = JSON.parse(fs.readFileSync(`${folder}/overview.json`, 'utf8')).rows;
const snapshot = JSON.parse(fs.readFileSync(`${folder}/snapshots.json`, 'utf8')).snapshots.find((s: any) => s.id === 164);
if (!snapshot || snapshot.status !== 'success' || !snapshot.createdAt.startsWith('2026-11-23')) throw Error('Expected successful Nov23 snapshot 164');
if (rows.some((r: any) => r.scoreVersion !== 'v4')) throw Error('Comparison requires frozen v4 baseline, not already-rescored rows');
const weights = [0, 0.25, 0.5];
const results = weights.map(weight => {
 const ranked = rows.map((r: any) => {
  if (!r.scoreComponents) throw Error('Snapshot export must contain scoreComponents');
  const bonus = holdingsSizeBonus(r.holdingsUsd, weight);
  const score = scoreFromComponents({...r.scoreComponents, capital: r.scoreComponents.capital * bonus});
  if(weight===0 && score!==r.score) throw Error(`Baseline mismatch ${r.tokenKey}`);
  return {...r, candidateScore: score, bonus};
 }).sort((a: any,b: any)=>b.candidateScore-a.candidateScore || b.holdingsUsd-a.holdingsUsd || a.tokenKey.localeCompare(b.tokenKey));
 return {weight, capped:ranked.filter((r:any)=>r.candidateScore===r.scoreComponents.evidenceCap).length, rows:ranked.map((r: any,i:number)=>({tokenKey:r.tokenKey,symbol:r.tokenSymbol,rank:i+1,score:r.candidateScore,baselineScore:r.score,holdings:r.holdingsUsd,holders:r.smwIn,favorites:r.favoriteEntityCount,bonus:r.bonus,components:r.scoreComponents}))};
});
fs.writeFileSync(`${folder}/comparison.json`, JSON.stringify({snapshotId:164, method:'Frozen snapshot sensitivity analysis, not forward return validation',results},null,2));
for(const result of results) console.log(JSON.stringify({weight:result.weight,capped:result.capped,targets:result.rows.filter((r:any)=>/^(DRV|CARDS|SURPLUS)$/i.test(r.symbol)),top10:result.rows.slice(0,10).map((r:any)=>({symbol:r.symbol,holdings:r.holdings,score:r.score}))}));
