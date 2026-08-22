/* Replicates the client's local pass-and-play loop (seatFor + redact + applyAction)
   without a DOM, to prove the handover never shows the wrong player's hand. */
var E = require('/home/claude/tideholm/engine.js');
var pass=0, fail=0, fails=[];
function ok(c,m){if(c)pass++;else{fail++;fails.push(m);}}
function eq(a,b,m){ok(a===b,m+' (got '+JSON.stringify(a)+' want '+JSON.stringify(b)+')');}

function seatFor(g){
  if (g.phase==='over'||g.phase==='lobby') return 0;
  if (g.trade && g.trade.to.length){
    var w=g.trade.to.filter(function(i){return g.trade.declined.indexOf(i)<0;});
    if (w.length) return w[0];
  }
  if (g.phase==='discard' && g.pendingDiscard && g.pendingDiscard.length) return g.pendingDiscard[0];
  return E.currentPlayer(g);
}

// seatFor must agree whether it is handed a raw game or a redacted view
for (var s=0;s<12;s++){
  var g=E.createGame({code:'L',seed:s});
  for(var i=0;i<4;i++) E.addPlayer(g,'P'+i,'L'+i);
  E.startGame(g);
  var guard=0, mism=0, wronghand=0, completed=false;
  while(g.phase!=='over' && guard++<6000){
    var seat=seatFor(g);
    var view=E.redact(g,g.players[seat].id);
    // the visible hand must always belong to whoever is about to act
    if(view.me!==seat) mism++;
    if(view.players[seat].hand===null) wronghand++;
    if(seatFor(view)!==seat) mism++;

    if(g.phase==='setup'){
      var spots=E.legalSettlementSpots(g,seat,true), done=false;
      spots=spots.sort(function(){return ((s*97+guard*31)%7)-3;});
      for(var a=0;a<spots.length&&!done;a++){
        var vv=g.board.verts[spots[a]];
        for(var b=0;b<vv.adj.length;b++){
          var ek=E.ekey(spots[a],vv.adj[b]);
          if(g.roads[ek]!=null)continue;
          if(E.applyAction(g,seat,{type:'setupPlace',vert:spots[a],edge:ek}).ok){done=true;break;}
        }
      }
      if(!done)break; continue;
    }
    if(g.phase==='discard'){
      var pl=g.players[seat],need=Math.floor(E.handSize(pl.hand)/2),cards={};
      E.RES.forEach(function(r){while(need>0&&(cards[r]||0)<pl.hand[r]){cards[r]=(cards[r]||0)+1;need--;}});
      if(!E.applyAction(g,seat,{type:'discard',cards:cards}).ok)break;
      continue;
    }
    if(g.trade){
      // responder decides, using only what the redacted view shows them
      var can=E.canPay(view.players[seat].hand,g.trade.get);
      E.applyAction(g,seat,{type:'respondTrade',accept:can});
      if(g.trade && g.trade.declined.length===g.trade.to.length){
        E.applyAction(g,g.trade.from,{type:'cancelTrade'});
      }
      continue;
    }
    if(g.phase==='roll'){E.applyAction(g,seat,{type:'roll'});continue;}
    if(g.phase==='robber'){
      var cand=g.board.hexes.filter(function(h){return h.id!==g.robber;});
      var h=cand[(guard*7)%cand.length];
      var v=E.robberVictims(g,h.id,seat);
      E.applyAction(g,seat,{type:'moveRobber',hex:h.id,victim:v.length?v[0]:null});
      continue;
    }
    if(g.phase==='main'){
      var p=g.players[seat],acted=false;
      var mine=Object.keys(g.buildings).filter(function(k){return g.buildings[k].p===seat&&g.buildings[k].type==='settlement';});
      if(mine.length&&E.canPay(p.hand,E.COST.city))acted=E.applyAction(g,seat,{type:'buildCity',vert:mine[0]}).ok;
      if(!acted&&E.canPay(p.hand,E.COST.settlement)){var ss=E.legalSettlementSpots(g,seat,false);if(ss.length)acted=E.applyAction(g,seat,{type:'buildSettlement',vert:ss[0]}).ok;}
      if(!acted&&E.canPay(p.hand,E.COST.road)&&(guard%3)){var rs=E.legalRoadSpots(g,seat);if(rs.length)acted=E.applyAction(g,seat,{type:"buildRoad",edge:rs[guard%rs.length]}).ok;}
      if(!acted&&E.canPay(p.hand,E.COST.dev)&&g.dev.length)acted=E.applyAction(g,seat,{type:'buyDev'}).ok;
      if(!acted&&p.dev.indexOf('knight')>=0&&!g.playedDevThisTurn)acted=E.applyAction(g,seat,{type:'playDev',card:'knight'}).ok;
      // open a trade sometimes to exercise the responder handover
      if(!acted&&guard%23===0){
        var have=E.RES.filter(function(r){return p.hand[r]>0;})[0];
        var want=E.RES.filter(function(r){return p.hand[r]===0;})[0];
        if(have&&want)acted=E.applyAction(g,seat,{type:'offerTrade',give:{[have]:1},get:{[want]:1}}).ok;
      }
      if(!acted){var sur=E.RES.filter(function(r){return p.hand[r]>=E.tradeRate(g,seat,r);})[0];
        if(sur){var want=E.RES[(guard+seat)%5];if(want!==sur)acted=E.applyAction(g,seat,{type:'bankTrade',give:sur,get:want}).ok;}}
      if(!acted)E.applyAction(g,seat,{type:'endTurn'});
      continue;
    }
    break;
  }
  if(g.phase==='over')completed=true;
  eq(mism,0,'seed '+s+': viewer always matches the acting seat');
  eq(wronghand,0,'seed '+s+': acting player can always see their own hand');
  ok(completed,'seed '+s+': local game reaches a winner');
}
console.log('\nPASS '+pass+'   FAIL '+fail);
if(fail){fails.slice(0,10).forEach(function(f){console.log('  ✗ '+f);});process.exit(1);}
