insert into hosts(slug,name,email,tz) values('demo','Demo Host','demo@slotbook.dev','Asia/Kolkata');
insert into event_types(host_id,slug,name,duration_min,capacity,buffer_after_min)
 select id,'intro-30','Intro call (1:1)',30,1,10 from hosts where slug='demo';
insert into event_types(host_id,slug,name,duration_min,capacity)
 select id,'workshop-60','Group workshop',60,5 from hosts where slug='demo';
insert into availability_rules(host_id,weekday,start_time,end_time)
 select h.id,d,t.s::time,t.e::time from hosts h, generate_series(1,5) d,
 (values('09:00','13:00'),('14:00','17:00')) t(s,e) where h.slug='demo';
