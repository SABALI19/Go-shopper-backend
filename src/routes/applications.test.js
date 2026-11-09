import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { errorHandler } from "../middleware/errors.js";
import { createApplicationsRouter, createAdminApplicationsRouter, validateData } from "./applications.js";
import { createAdminStoresRouter } from "./adminStores.js";

function query(value) { const api = { select() { return api; }, sort() { return api; }, lean() { return Promise.resolve(value); }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } }; return api; }
function appFor(path, router, { role = "customer" } = {}) { const app = express(); app.use(express.json()); app.use(path, router({ authenticate(req, res, next) { const id = req.headers.authorization?.slice(7); if (!id) return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Sign in is required" } }); req.auth = { userId: id, role }; next(); }, authorizeAdmin(req, res, next) { return req.auth.role === "admin" ? next() : res.status(403).json({ error: { code: "FORBIDDEN", message: "Admin role required" } }); } })); app.use(errorHandler); return app; }
async function request(app, { method = "GET", path, user = "customer-1", body } = {}) { const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve)); try { const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { ...(user ? { Authorization: `Bearer ${user}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, body: await response.json() }; } finally { await new Promise(resolve => server.close(resolve)); } }
const supermarketData = { businessName: "Market One", legalName: "Market One Limited", fullName: "Sam Shopper", email: "sam@example.com", phone: "+2348012345678", ownershipRole: "owner", ownershipDeclaration: true, category: "Grocery", description: "Neighborhood grocery store", address: "1 Main Road", city: "Lagos", state: "Lagos", operatingHours: "Daily, 8am–9pm" };

test("application submissions require auth, validate details, and ignore attempted role escalation", async () => {
  const records = [];
  const ApplicationModel = { findOne: () => query(null), async create(value) { const row = { ...value, _id: `id-${records.length}`, createdAt: new Date(), history: value.history }; records.push(row); return row; } };
  const UserModel = { findOne: () => ({ select: () => query(null) }) };
  // Override route dependencies without changing the public request contract.
  const testApp = express(); testApp.use(express.json()); testApp.use("/api/applications", createApplicationsRouter({ ApplicationModel, UserModel, authenticate(req,res,next) { const id=req.headers.authorization?.slice(7); if(!id)return res.status(401).json({error:{code:"UNAUTHORIZED",message:"Sign in is required"}});req.auth={userId:id};next(); } })); testApp.use(errorHandler);
  assert.equal((await request(testApp, { method: "POST", path: "/api/applications/supermarket", user: null, body: { data: supermarketData } })).status, 401);
  assert.throws(() => validateData("supermarket", { ...supermarketData, role: "admin" }), /unsupported fields/i);
  assert.equal((await request(testApp, { method: "POST", path: "/api/applications/supermarket", body: { role: "admin", data: supermarketData } })).status, 201);
  assert.equal(records[0].status, "pending_review"); assert.equal(records[0].applicantClerkUserId, "customer-1"); assert.equal(records[0].data.role, undefined);
  assert.equal((await request(testApp, { method: "POST", path: "/api/applications/rider", body: { data: { fullName: "Sam", email: "bad", phone: "1", address: "x", operatingArea: "Lagos", vehicleType: "Bike" } } })).status, 400);
});

test("applicants can only see their own applications and admin decisions are authorized and audited", async () => {
  const row = { _id: "64b000000000000000000001", reference: "GS-S-ABC", type: "supermarket", applicantClerkUserId: "customer-1", status: "pending_review", data: supermarketData, feedback: "", reviewerNotes: "", history: [], save: async function(){return this;} };
  const ApplicationModel = { find: filter => query(filter.applicantClerkUserId === row.applicantClerkUserId ? [row] : []).sort, findById: () => query(row) };
  // Query with sort chain for applicant list.
  ApplicationModel.find = filter => { const q={ sort(){return q;}, lean(){return Promise.resolve(filter.applicantClerkUserId===row.applicantClerkUserId?[row]:[]);} }; return q; };
  const testApplicantApp=express();testApplicantApp.use(express.json());testApplicantApp.use("/api/applications",createApplicationsRouter({ApplicationModel,authenticate(req,res,next){const id=req.headers.authorization?.slice(7);if(!id)return res.status(401).json({error:{code:"UNAUTHORIZED",message:"Sign in is required"}});req.auth={userId:id};next();}}));testApplicantApp.use(errorHandler);
  assert.equal((await request(testApplicantApp,{path:"/api/applications/mine",user:"customer-2"})).body.applications.length,0);
  assert.equal((await request(testApplicantApp,{path:"/api/applications/mine",user:"customer-1"})).body.applications.length,1);
  const admin = express(); admin.use(express.json()); admin.use("/api/admin/applications", createAdminApplicationsRouter({ ApplicationModel, authenticate(req,res,next){req.auth={userId:"customer-1",role:"customer"};next();}, authorizeAdmin(req,res,next){return req.auth.role==="admin"?next():res.status(403).json({error:{code:"FORBIDDEN",message:"Admin role required"}});} })); admin.use(errorHandler);
  assert.equal((await request(admin,{path:`/api/admin/applications/${row._id}`})).status,403);
  const audit=[]; const UserModel={findOne:()=>Promise.resolve({role:"customer",isSuspended:false,save:async()=>{}})}; const secureAdmin=express();secureAdmin.use(express.json());secureAdmin.use("/api/admin/applications",createAdminApplicationsRouter({ApplicationModel,UserModel,AuditModel:{async create(item){audit.push(item);}},authenticate(req,res,next){req.auth={userId:"admin-1",role:"admin"};next();},authorizeAdmin(req,res,next){next();}}));secureAdmin.use(errorHandler);
  assert.equal((await request(secureAdmin,{method:"PATCH",path:`/api/admin/applications/${row._id}/decision`,body:{decision:"rejected"}})).status,400);
  const result=await request(secureAdmin,{method:"PATCH",path:`/api/admin/applications/${row._id}/decision`,body:{decision:"rejected",reason:"Missing required details"}});
  assert.equal(result.status,200);assert.equal(row.status,"rejected");assert.equal(audit[0].targetType,"application");assert.equal(audit[0].action,"application_rejected");
});

test("supermarket approval provisions one inactive store and repeated approval is idempotent", async () => {
  const application={_id:"64b000000000000000000002",reference:"GS-S-TEST",type:"supermarket",applicantClerkUserId:"customer-owner",status:"pending_review",active:true,data:supermarketData,history:[],save:async function(){return this;}};
  const user={_id:"64b000000000000000000003",role:"customer",isSuspended:false,save:async function(){return this;}}; const stores=[]; const audits=[]; let clerkRole="customer";
  const ApplicationModel={findById:()=>query(application)};
  const UserModel={findOne:()=>Promise.resolve(user)};
  const StoreModel={findOne:()=>query(null),async create(value){const store={_id:"64b000000000000000000004",...value};stores.push(store);return store;},findById:async()=>stores[0]||null};
  const serverApp=express();serverApp.use(express.json());serverApp.locals.clerkClient={users:{getUser:async()=>({publicMetadata:{role:clerkRole}}),updateUserMetadata:async(_id,metadata)=>{clerkRole=metadata.publicMetadata.role;}}};
  serverApp.use("/api/admin/applications",createAdminApplicationsRouter({ApplicationModel,UserModel,StoreModel,AuditModel:{async create(value){audits.push(value);}},authenticate(req,res,next){req.auth={userId:"admin-1"};next();},authorizeAdmin(_req,_res,next){next();}}));serverApp.use(errorHandler);
  const first=await request(serverApp,{method:"PATCH",path:`/api/admin/applications/${application._id}/decision`,body:{decision:"approved"}});
  const second=await request(serverApp,{method:"PATCH",path:`/api/admin/applications/${application._id}/decision`,body:{decision:"approved"}});
  assert.equal(first.status,200);assert.equal(second.status,200);assert.equal(second.body.idempotent,true);assert.equal(stores.length,1);assert.equal(stores[0].isActive,false);assert.equal(stores[0].isApproved,true);assert.equal(user.role,"supermarket");assert.equal(clerkRole,"supermarket");assert.equal(audits.length,1);
});

test("requesting more information permits only the applicant to resubmit and rider approval is repeat-safe", async () => {
  const row={_id:"64b000000000000000000005",reference:"GS-R-TEST",type:"rider",applicantClerkUserId:"rider-customer",status:"pending_review",active:true,data:{fullName:"Rider Person",email:"rider@example.com",phone:"08000000000",address:"1 Road",operatingArea:"Lagos",vehicleType:"Motorcycle"},feedback:"",reviewerNotes:"",history:[],save:async function(){return this;}};
  const user={_id:"64b000000000000000000006",role:"customer",isSuspended:false,save:async function(){return this;}};const audit=[];let clerkRole="customer";
  const ApplicationModel={findById:()=>query(row),findOne:filter=>query(filter.applicantClerkUserId===row.applicantClerkUserId?row:null)};
  const UserModel={findOne:()=>Promise.resolve(user)};
  const admin=express();admin.use(express.json());admin.locals.clerkClient={users:{getUser:async()=>({publicMetadata:{role:clerkRole}}),updateUserMetadata:async(_id,meta)=>{clerkRole=meta.publicMetadata.role;}}};admin.use("/api/admin/applications",createAdminApplicationsRouter({ApplicationModel,UserModel,AuditModel:{async create(item){audit.push(item);}},authenticate(req,res,next){req.auth={userId:"admin-1"};next();},authorizeAdmin(_req,_res,next){next();}}));admin.use(errorHandler);
  const requested=await request(admin,{method:"PATCH",path:`/api/admin/applications/${row._id}/decision`,body:{decision:"needs_information",reason:"Please confirm the operating area"}});
  assert.equal(requested.status,200);assert.equal(row.status,"needs_information");
  const applicant=express();applicant.use(express.json());applicant.use("/api/applications",createApplicationsRouter({ApplicationModel,UserModel,authenticate(req,res,next){req.auth={userId:req.headers.authorization?.slice(7)};next();}}));applicant.use(errorHandler);
  assert.equal((await request(applicant,{method:"PATCH",path:`/api/applications/${row._id}`,user:"another-user",body:{data:row.data}})).status,404);
  const resubmitted=await request(applicant,{method:"PATCH",path:`/api/applications/${row._id}`,user:"rider-customer",body:{data:{...row.data,additionalInformation:"Serving Ikeja"}}});
  assert.equal(resubmitted.status,200);assert.equal(row.status,"pending_review");assert.equal(row.data.additionalInformation,"Serving Ikeja");
  row.status="under_review";
  const approved=await request(admin,{method:"PATCH",path:`/api/admin/applications/${row._id}/decision`,body:{decision:"approved"}});
  const repeated=await request(admin,{method:"PATCH",path:`/api/admin/applications/${row._id}/decision`,body:{decision:"approved"}});
  assert.equal(approved.status,200);assert.equal(repeated.body.idempotent,true);assert.equal(user.role,"rider");assert.equal(user.riderProfile.approvalStatus,"approved");assert.equal(user.riderProfile.isOnline,false);assert.equal(clerkRole,"rider");assert.equal(audit.length,2);
});

test("admin can create an inactive store only for an existing eligible owner and audit it", async () => {
  const owner={clerkUserId:"user_existing",role:"customer",isSuspended:false,save:async function(){return this;}};const stores=[];const audits=[];let metadataRole="customer";
  const admin=express();admin.use(express.json());admin.locals.clerkClient={users:{getUser:async()=>({publicMetadata:{role:metadataRole}}),updateUserMetadata:async(_id,meta)=>{metadataRole=meta.publicMetadata.role;}}};
  admin.use("/api/stores",createAdminStoresRouter({UserModel:{findOne:async()=>owner},StoreModel:{async create(value){const record={_id:"64b000000000000000000007",...value,createdAt:new Date(),toObject(){return this;}};stores.push(record);return record;}},AuditModel:{async create(value){audits.push(value);}},authenticate(req,res,next){req.auth={userId:"admin-1"};next();},authorizeAdmin(_req,_res,next){next();}}));admin.use(errorHandler);
  const response=await request(admin,{method:"POST",path:"/api/stores/admin/create-for-owner",body:{ownerEmail:"owner@example.com",name:"Corner Market",category:"Grocery",role:"admin"}});
  assert.equal(response.status,400);
  const created=await request(admin,{method:"POST",path:"/api/stores/admin/create-for-owner",body:{ownerEmail:"owner@example.com",name:"Corner Market",category:"Grocery"}});
  assert.equal(created.status,201);assert.equal(stores.length,1);assert.equal(stores[0].isActive,false);assert.equal(stores[0].approvalStatus,"approved");assert.equal(owner.role,"supermarket");assert.equal(metadataRole,"supermarket");assert.equal(audits[0].action,"store_created_for_owner");
});
