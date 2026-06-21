/**
 * Lightweight Chinese pinyin conversion utility.
 * No external dependencies — built-in lookup table for ~2500 common characters.
 *
 * Storage format (inverted map): each key is a run of chars sharing the same pinyin syllable.
 * At module load the table is expanded into a char→pinyin Map for O(1) lookup.
 */

// ---------------------------------------------------------------------------
// Raw data: syllable → chars (no tones, suitable for similarity matching)
// Each entry covers all common characters pronounced as that syllable.
// ---------------------------------------------------------------------------
const RAW: Record<string, string> = {
  a: '啊阿',
  ai: '哎唉爱碍矮艾癌挨埃哀蔼隘暧霭皑锿',
  an: '安按暗岸案鞍氨庵桉谙鹌俺胺铵黯',
  ang: '昂肮',
  ao: '奥傲熬澳凹嗷拗袄坳鏊螯鳌',
  ba: '把爸吧巴拔罢霸坝芭疤扒叭捌笆耙钯粑',
  bai: '白百败摆拜柏佰掰呗捭',
  ban: '半办般板班搬版颁瓣拌绊扳斑泮阪坂',
  bang: '帮棒绑磅膀蚌傍谤镑榜浜',
  bao: '报保宝抱包暴薄剥爆饱胞堡褒鲍雹豹苞葆煲刨',
  bei: '被北备杯背倍贝悲辈碑卑臂萆呗孛狈钡鹎',
  ben: '本奔笨苯贲锛',
  beng: '蹦崩绷泵迸甭嗙',
  bi: '比必笔鼻璧毕辟避壁闭逼臂碧蔽弊匕彼毙庇泌鄙痹陛秘篦髀裨俾濞荸滗铋',
  bian: '变边便遍编辩辨鞭贬扁砭匾蝙蝙',
  biao: '表标彪裱镖膘髦飚',
  bie: '别憋瘪鳖',
  bin: '宾濒殡滨彬斌摈膑镔髌',
  bing: '并冰兵病饼丙柄秉摒禀槟',
  bo: '波播伯博薄勃脖驳泊剥搏铂舶柏钵孛箔帛渤礴擘拨菠鹁亳簸',
  bu: '不步布部补捕哺卜堡簿怖埠钚钸',
  ca: '擦嚓',
  cai: '才材菜财采彩猜踩裁睬',
  can: '参残惭灿蚕餐惨掺骖璨',
  cang: '仓藏苍舱沧',
  cao: '草操曹槽嘈糙艚',
  ce: '侧策册测厕',
  cen: '参岑涔',
  ceng: '层曾蹭噌',
  cha: '查差茶察插叉茬刹碴岔搽馇猹',
  chai: '柴拆钗豺侪',
  chan: '产单禅缠蝉馋颤铲阐掸忏骣蟾婵谄廛孱',
  chang: '长场常唱厂肠偿倡昌猖娼畅徜怅淌苌伥菖鬯',
  chao: '超朝潮炒抄钞嘲剿晁巢',
  che: '车彻撤扯掣',
  chen: '陈沉晨趁称臣衬尘辰忱谌抻碜宸',
  cheng: '成城程诚承乘称盛撑惩澄称橙骋逞瞠铛塍枨',
  chi: '吃尺齿迟池赤耻斥持叱炽翅侈驰匙痴刺哧笞踟茌褫蚩',
  chong: '冲充虫崇重宠憧铳舂',
  chou: '仇愁筹酬丑抽臭稠瞅畴踌惆绸',
  chu: '出处初除储触蜀础楚雏厨矗搐锄滁刍怵绌杵褚',
  chuan: '传船穿串川喘椽氚',
  chuang: '窗床创闯',
  chui: '吹垂锤捶',
  chun: '春纯唇蠢醇椿',
  chuo: '戳绰踔',
  ci: '次此刺词辞磁慈雌伺祠茨瓷赐蠢',
  cong: '从丛匆聪葱囱琮',
  cou: '凑辏',
  cu: '粗促醋簇蹴猝',
  cuan: '窜篡攒蹿',
  cui: '催脆翠璀粹萃淬啐瘁',
  cun: '村寸存忖',
  cuo: '错措磋挫搓撮锉',
  da: '大达打答搭哒沓褡耷瘩',
  dai: '代带待贷戴袋呆逮怠歹殆黛岱迨傣',
  dan: '单旦但担弹蛋淡胆氮丹掸诞惮耽眈',
  dang: '当党挡档荡宕凼砀铛裆',
  dao: '到道倒导刀岛悼稻盗捣祷纛',
  de: '的得德',
  dei: '得',
  den: '扽',
  deng: '等登灯邓凳瞪蹬磴澄噔',
  di: '地第底低的笛敌弟递帝堤抵蒂滴嫡迪氐狄涤缔砥诶髫觌',
  dian: '电点店典颠掂癫踮淀垫钿靛奠佃甸惦玷腆',
  diao: '调吊雕钓掉刁叼貂碉',
  die: '跌碟蝶迭叠爹牒谍堞',
  ding: '定顶丁订钉盯鼎叮铤腚酊',
  diu: '丢铥',
  dong: '动东冬洞懂栋冻董咚恫峒胴硐',
  dou: '都斗豆抖陡兜蔸蚪逗痘',
  du: '度独读都堵肚毒渡镀睹赌杜妒笃椟犊黩牍蠹',
  duan: '断段短端锻椴',
  dui: '对队兑堆碓憝',
  dun: '顿蹲盾吨敦钝囤遁墩礅砘',
  duo: '多夺朵躲舵惰堕哆跺剁踱',
  e: '额鹅俄恶呃峨饿鳄颚扼噩婀厄',
  ei: '欸',
  en: '恩摁蒽',
  er: '而二耳儿尔饵鸸',
  fa: '发法罚乏伐阀筏砝珐',
  fan: '反饭范翻繁烦犯泛番返贩樊帆矾藩蕃幡梵畈',
  fang: '方放房防访仿妨坊芳肪彷舫',
  fei: '费非飞肥废肺啡沸匪翡菲绯腓痱狒霏鲱',
  fen: '分份粉奋坟氛纷忿愤芬焚吩汾鼢',
  feng: '风凤丰封锋逢缝蜂峰奉冯讽',
  fu: '父服福复负妇幅副府付富辅腹伏赴浮赋覆附夫符抚扶腐俯斧脯哺腑孵敷馥拂弗芙茯苻俘袱蝠绂黻孚',
  ga: '噶尬嘎轧',
  gai: '改该盖概钙溉丐',
  gan: '干感赶敢肝杆甘橄秆赣竿擀泔坩苷',
  gang: '刚港钢纲缸岗杠肛戆筻',
  gao: '高告稿搞膏糕镐皋睾篙羔槁诰',
  ge: '个各格革歌隔阁葛戈搁鸽割哥蛤胳颌铬袼硌鬲仡',
  gei: '给',
  gen: '根跟亘艮',
  geng: '更耕梗羹哽庚赓鲠',
  gong: '工共公功供宫弓攻巩贡拱躬恭龚汞蚣觥',
  gou: '够狗购沟勾构垢钩苟篝佝诟觏彀',
  gu: '古故骨股鼓固顾雇估鼓蛊嫁辜锢菇咕呱毂孤箍痼沽汩鹄',
  gua: '瓜刮挂括褂寡卦诖',
  guai: '怪拐乖',
  guan: '关管官观惯贯罐冠馆灌广棺莞涫',
  guang: '广光逛犷',
  gui: '规鬼贵归轨柜桂硅圭诡癸匮刽龟皈瑰炅妫',
  gun: '滚棍辊鲧衮磙',
  guo: '国过果裹锅郭括蝈帼惑',
  ha: '哈蛤',
  hai: '还海害骸孩亥骇嗨醢',
  han: '汉寒含旱韩汗憾悍喊罕翰邯酣撼捍菡颔焊馄',
  hang: '行航杭巷夯',
  hao: '好号毫豪浩耗郝皓昊嗥',
  he: '和合河核贺喝何荷阖赫鹤壑涸劾褐曷嗬',
  hei: '黑嘿',
  hen: '很恨狠痕',
  heng: '横恒衡亨哼',
  hong: '红轰洪鸿宏弘哄烘虹訇蕻',
  hou: '后候厚侯喉猴吼糇篌',
  hu: '护互湖户乎呼虎狐壶糊胡沪蝴忽浒葫鹄唬煳瑚笏醐',
  hua: '化花话画华滑划哗豁桦砉',
  huai: '坏怀淮踝',
  huan: '换环欢患缓还幻唤桓涣焕鬟寰豢奂痪浣',
  huang: '黄皇荒慌煌惶晃谎凰潢璜恍蝗幌簧隍徨',
  hui: '会回挥辉汇惠毁慧绘贿晦灰恢秽诙',
  hun: '混婚魂昏浑馄荤',
  huo: '或活火货获祸惑豁霍伙藿攉镬',
  ji: '机及级己基记技几济激集系计季际极极积纪绩寄继迹嫉迹脊辑吉即既冀籍肌饥疾拒鸡藉棘戟羁觉玑叽叫亟嵇稷觊佶诘笈蒺偈赍',
  jia: '家加价假甲驾嘉架夹佳嫁夹贾颊荚珈胛岬浃痂',
  jian: '间见建检减简坚监键健尖剪兼件减贱箭渐浅肩荐践舰坚奸歼缄茧间殄涧溅缄鹣囝楗睑',
  jiang: '将江讲降疆浆僵强蒋奖酱桨匠绛犟姜',
  jiao: '教交较叫角脚校轿娇骄绞矫搅跤椒焦蕉礁侥嚼缴皎铰窖浇徼茭峤湫',
  jie: '结解接界届节街截劫姐揭皆洁借阶捷睫碣诫戒羯拮桀秸讦',
  jin: '进今近尽金仅筋紧锦津禁仁劲浸晋巾谨矜噤觐缙堇',
  jing: '经京精境静竟进井竞敬景惊净镜径晶睛兢婧痉阱迳胫靖靓泾',
  jiong: '窘炯迥炅',
  jiu: '就旧九久究纠酒救厩灸玖韭柩咎僦鸠臼疚',
  ju: '局据举句具拒居举聚距剧拘矩菊俱巨咀锯驹雎掬踞裾鞠疽龃沮',
  juan: '卷圈捐眷倦隽绢娟鄄桊',
  jue: '决绝觉角掘爵厥崛倔撅攫噱矍蕨獗谲钁',
  jun: '军均俊君菌峻竣钧浚郡骏捃筠',
  ka: '卡咖咔喀胩',
  kai: '开凯慨楷垲忾',
  kan: '看刊砍堪侃勘龛戡',
  kang: '康慷抗炕扛亢钪',
  kao: '考靠烤犒铐',
  ke: '可科克客课刻渴棵颗磕壳咳苛轲珂氪窠',
  ken: '肯啃垦恳',
  keng: '坑铿',
  kong: '空控孔恐倥崆箜',
  kou: '口扣寇叩抠蔻',
  ku: '苦哭库酷裤枯骷窟堀',
  kua: '夸跨垮挎胯',
  kuai: '快块筷脍',
  kuan: '宽款',
  kuang: '况矿狂框旷眶筐诓邝夼',
  kui: '亏愧葵窥溃魁匮盔馈岿篑喟睽',
  kun: '困昆捆坤锟髡',
  kuo: '括扩廓阔',
  la: '啦拉辣蜡腊垃喇邋旯砬',
  lai: '来赖莱睐籁涞',
  lan: '蓝滥缆篮兰懒览揽拦烂阑栏岚澜斓婪',
  lang: '浪朗廊郎狼琅榔莨螂',
  lao: '老劳落捞涝姥牢络烙酪唠耢',
  le: '了乐勒肋嘞',
  lei: '类累泪雷垒磊蕾肋擂镭羁诔',
  leng: '冷楞棱',
  li: '力里理利历例立离礼黎厘丽粒梨莉励犁隶栗狸厉篱棱僻黧俐砾藜鲤锂蜊鹂唳哩荔罹戾',
  lian: '联练脸连怜廉恋帘镰敛涟莲潋琏',
  liang: '量两亮梁凉粮辆良靓踉晾',
  liao: '了料聊疗辽廖寥瞭撂嘹獠钌镣',
  lie: '列烈裂劣猎冽捩趔',
  lin: '临林邻凛磷霖淋鳞麟琳赁吝蔺躏',
  ling: '领令零灵令另零岭凌铃伶菱羚棱泠囹绫瓴翎',
  liu: '六流留刘柳硫溜瘤榴遛馏碌鎏',
  long: '龙隆弄笼聋拢珑窿陇茏咙胧',
  lou: '楼漏陋喽搂蒌',
  lu: '路陆录绿旅虑律率颅露鹿庐炉鲁卤卢碌芦鲈胪',
  luan: '乱卵卵峦孪銮',
  lun: '论伦轮纶抡囵',
  luo: '落络罗裸螺骡逻萝锣箩猡',
  lv: '旅绿律吕虑滤氯驴铝侣捋',
  ma: '马妈吗骂麻码嘛抹蟆',
  mai: '买卖麦迈埋脉劢',
  man: '满漫慢蔓曼瞒蛮馒幔镘',
  mang: '忙盲芒茫莽蟒',
  mao: '毛帽猫貌茂冒锚矛铆懋卯昴',
  me: '么',
  mei: '没美每煤眉媒梅妹霉魅枚昧玫莓镁',
  men: '们门闷扪',
  meng: '梦盟猛蒙朦萌氓孟勐懵蜢蠓艋',
  mi: '米密秘迷谜泌幂觅弭靡麋猕汨弥宓糜',
  mian: '面棉免绵眠勉娩缅腼湎',
  miao: '苗秒妙描庙缈渺瞄藐淼邈',
  mie: '灭蔑咩',
  min: '民敏闵皿泯悯珉岷苠',
  ming: '明名命鸣铭冥溟暝螟',
  miu: '谬',
  mo: '模末没磨默墨摸膜摩魔莫漠沫陌谟茉抹蓦貘',
  mou: '某谋眸',
  mu: '木目母牧幕暮募模墓睦穆沐拇毪钼',
  na: '那拿纳哪钠呐捺',
  nai: '乃奶耐奈萘佴氖',
  nan: '南难男喃楠腩',
  nao: '脑闹恼挠呶',
  ne: '呢',
  nei: '内那哪',
  nen: '嫩',
  neng: '能',
  ni: '你呢泥拟逆倪腻妮霓溺猊旎',
  nian: '年念酿捻碾辗撵黏',
  niang: '娘酿',
  niao: '鸟尿袅溺',
  nie: '捏镊聂涅蹑孽啮',
  nin: '您',
  ning: '宁凝拧泞佞狞柠聍',
  niu: '牛纽扭妞钮拗',
  nong: '农弄浓脓',
  nu: '努怒奴驽孥',
  nuan: '暖',
  nuo: '诺挪懦糯傩',
  nv: '女',
  o: '哦噢',
  ou: '欧偶藕鸥呕殴瓯',
  pa: '怕爬趴啪耙葩琶',
  pai: '派排牌徘湃',
  pan: '判盘叛攀潘盼磐蟠',
  pang: '旁胖膀庞彷螃',
  pao: '跑泡炮跑袍抛刨脬',
  pei: '配培陪佩赔胚妃裴沛醅',
  pen: '盆喷',
  peng: '朋碰捧鹏棚篷蓬澎膨烹嘭',
  pi: '皮批疲披啤匹屁劈辟琵癖痞譬僻毗蚍邳罴',
  pian: '片偏篇骗翩',
  piao: '漂票飘瞟嫖',
  pie: '瞥撇苤',
  pin: '品贫频拼拼聘牝',
  ping: '平评屏瓶乒坪萍枰',
  po: '破颇迫坡婆泼魄朴珀粕钋',
  pou: '剖裒',
  pu: '普铺朴葡蒲瀑曝匍扑仆谱埔僕氆',
  qi: '其期气起七奇齐器汽企弃旗迹骑棋欺歧戚妻乞启汽棋讫琦琪祺稽脐崎萋鳍柒蹊锜',
  qia: '恰洽掐',
  qian: '前千钱迁签牵浅歉潜谦铅欠嵌谴黔乾虔钳堑骞倩茜阡',
  qiang: '强墙枪抢腔锵蔷羌呛跄戕',
  qiao: '桥侨悄瞧巧翘锹撬俏峭窍憔乔鞘樵',
  qie: '切且茄妾惬怯窃',
  qin: '亲琴勤侵秦禽芹沁寝覃',
  qing: '情清请青轻庆晴顷擎磬蜻氰卿倾',
  qiong: '穷琼',
  qiu: '求球秋丘仇囚鳅蚯虬',
  qu: '区去取趋曲渠屈驱劬岖蛆衢躯詟',
  quan: '全权圈泉拳券劝犬痊绻',
  que: '却缺确鹊雀阙炔瘸',
  qun: '群裙',
  ran: '然燃染冉苒',
  rang: '让嚷壤瓤攘',
  rao: '绕扰饶娆',
  re: '热惹若',
  ren: '人任认仁忍韧刃纫妊',
  reng: '仍扔',
  ri: '日',
  rong: '容融荣熔溶绒蓉嵘戎茸榕冗',
  rou: '肉柔揉蹂',
  ru: '如入乳汝辱儒孺褥蠕嚅',
  ruan: '软阮',
  rui: '瑞锐蕊芮',
  run: '润闰',
  ruo: '若弱',
  sa: '撒洒萨飒',
  sai: '赛塞腮噻',
  san: '三散伞叁毵',
  sang: '丧桑嗓',
  sao: '扫嫂骚搔臊',
  se: '色塞涩瑟铯',
  sen: '森',
  seng: '僧',
  sha: '沙杀傻啥厦砂纱刹煞鲨痧',
  shai: '晒筛',
  shan: '山善闪衫扇珊删膳伞掸汕骟擅赡苫蟮禅',
  shang: '上商尚赏伤裳晌绱墒',
  shao: '少烧稍绍召梢勺韶芍哨邵',
  she: '社舍蛇摄射涉舌折设赦慑',
  shei: '谁',
  shen: '身深神申甚慎审沈渗什肾绅参砷呻婶',
  sheng: '生声胜省升绳剩盛圣乘绳牲甥',
  shi: '是时事实世式使识市史师失势施十诗食石示视始士室试适式死似誓释职势氏嗜湿蚀拭矢逝仕柿侍噬峙嗜豕',
  shou: '手受收首授兽守寿售叟瘦',
  shu: '书数属树述熟输鼠主舒书术恕数竖墅庶赎蜀黍疏漱澍孰薯',
  shua: '刷耍',
  shuai: '衰摔帅甩',
  shuan: '栓涮',
  shuang: '双霜爽',
  shui: '水谁睡税',
  shun: '顺瞬舜',
  shuo: '说硕朔烁铄',
  si: '四思死司似斯丝私寺撕嗣伺饲肆厮',
  song: '送松耸宋诵讼颂怂悚嵩淞忪',
  sou: '搜艘叟嗽擞',
  su: '速素诉苏俗塑肃溯宿粟酥夙涑嗉愫',
  suan: '算酸蒜',
  sui: '岁虽随穗碎隧遂髓绥燧',
  sun: '孙损笋隼榫',
  suo: '所锁缩索梭唆嗦',
  ta: '他她它塔踏榻沓獭',
  tai: '太台抬态汰泰胎苔钛',
  tan: '谈探弹坦贪炭碳摊滩叹瘫痰毯坛',
  tang: '堂唐糖汤趟躺傥倘淌烫螳',
  tao: '套逃桃淘陶讨涛叨掏韬绦',
  te: '特忑忒铽',
  teng: '腾疼藤誊',
  ti: '题体提替梯踢剔啼缇',
  tian: '天田填甜添恬舔腆',
  tiao: '条挑跳调眺笤',
  tie: '铁贴帖',
  ting: '听庭停廷挺亭艇烃蜓',
  tong: '同通痛童统铜桶筒彤峒佟恸',
  tou: '头透投偷',
  tu: '图土突途吐兔涂徒屠嘟钍',
  tuan: '团湍',
  tui: '推腿退颓蜕褪',
  tun: '吞屯囤豚饨',
  tuo: '拖托脱妥驼陀椭鸵坨砣箨',
  wa: '挖哇蛙娃瓦袜洼',
  wai: '外歪',
  wan: '万完玩晚湾弯碗挽蔓蜿惋婉',
  wang: '往王望忘亡旺妄枉',
  wei: '为位未维威卫委微违危味慰胃惟喂畏渭巍唯韦尾魏围萎偎隈诿',
  wen: '文问稳温闻纹吻蚊紊',
  weng: '翁嗡瓮',
  wo: '我握窝卧沃涡斡幄蜗渥',
  wu: '无务物五武午舞误污勿屋吴雾乌悟捂戊晤寤鹉妩鼯',
  xi: '系息系析系戏洗席喜西细吸希习稀昔膝惜犀晰熙析羲玺皙觉蜥樨烯矽',
  xia: '下夏峡虾吓侠狭霞厦瞎匣辖',
  xian: '先显线限现咸鲜纤献险县贤腺衔馅掀仙弦陷嫌巡闲蚬岘苋羡铣',
  xiang: '向相象想象乡项享响香详降象厢湘箱翔巷橡飨',
  xiao: '小笑校肖消削晓效嚣逍潇萧哮霄蛸枭淆宵',
  xie: '些写谢解协斜歇携撷卸泄蟹邪楔鞋械',
  xin: '心新信辛欣忻锌芯衅馨昕',
  xing: '行星型形幸性醒兴杏腥猩邢刑荇',
  xiong: '雄熊胸凶汹兄',
  xiu: '秀修袖锈朽绣宿羞嗅岫',
  xu: '须需续许虚序徐叙蓄圩旭恤栩煦婿',
  xuan: '选玄宣悬旋炫绚渲萱',
  xue: '学血雪削穴靴薛',
  xun: '训询循巡讯迅熏浚汛逊驯荀',
  ya: '也牙压呀鸦哑雅押鸭崖涯哑睚',
  yan: '言研严验延颜盐演炎烟岩燕掩厌艳宴筵雁铅蜒咽腌砚衍阎奄彦焰',
  yang: '样阳央洋扬杨养让仰羊氧秧恙殃',
  yao: '要药摇遥腰么邀咬尧窈谣舀妖侥',
  ye: '也野叶夜业液爷椰曳掖',
  yi: '一以意义已医易益倚仪艺宜遗异亿忆疑伊役忆毅议逸亦弈奕揖咦怡迤懿猗镒羿',
  yin: '因引印银饮阴音隐尹吟殷淫寅胤龈',
  ying: '应英影迎营硬赢映盈颖鹰瑛莺婴樱缨萤',
  yo: '哟唷',
  yong: '用永勇涌拥雍泳踊庸佣蛹',
  you: '有由又游油友右幽优幼优悠诱鱿蚰蝣',
  yu: '与于于育遇雨预宇鱼欲语愈域渔御玉余予语芋誉裕愉喻峪吁粥豫虞娱驭舆煜淤淯馀毓',
  yuan: '员元原院源园远愿圆冤援袁苑缘渊鸳猿媛',
  yue: '月越乐约岳跃阅悦粤曰钺',
  yun: '云运允孕韵匀晕酝芸耘筠氲纭',
  za: '杂砸扎咋咱',
  zai: '在再载灾栽宰',
  zan: '赞暂攒咱簪',
  zang: '脏藏葬',
  zao: '早造枣皂灶糟噪燥躁藻',
  ze: '则责择泽仄啧',
  zei: '贼',
  zen: '怎',
  zeng: '增曾赠憎综',
  zha: '炸闸扎榨渣诈乍喳轧铡咤栅',
  zhai: '摘宅债斋窄',
  zhan: '站占战展蘸斩沾颤毡栈湛',
  zhang: '长张章掌涨账障仗丈彰胀樟嶂',
  zhao: '找着照召赵招朝兆沼爪肇',
  zhe: '这者折遮着折辙蔗褶',
  zhen: '真针珍阵振镇诊朕枕甄贞桢缜疹鸩',
  zheng: '政正争整证征郑蒸挣铮峥怔症帧',
  zhi: '只之知制质直指至止治支职志置智滞稚致纸植值芝蜘挚炙旨秩雉桎趾',
  zhong: '中重种众终钟肿忠衷仲踵冢',
  zhou: '周州洲舟粥宙皱昼轴肘咒纣绉',
  zhu: '主注住助株著朱珠诸猪贮竹逐嘱铸筑蛛烛驻拄柱蜘褚',
  zhua: '抓',
  zhuai: '拽',
  zhuan: '转专砖传赚篆撰',
  zhuang: '状装撞庄桩壮',
  zhui: '追锥坠赘缀',
  zhun: '准谆',
  zhuo: '着桌浊捉拙灼酌卓濯',
  zi: '字自子资紫姿滋咨仔孜兹恣梓淄',
  zong: '总综宗棕踪纵',
  zou: '走奏邹揍',
  zu: '组足族祖阻租卒俎',
  zuan: '钻攥',
  zui: '最嘴罪醉',
  zun: '尊遵',
  zuo: '做作坐左座昨佐琢撮',
};

// ---------------------------------------------------------------------------
// Build the char→pinyin map once at module load
// ---------------------------------------------------------------------------
const CHAR_TO_PINYIN = new Map<string, string>();

for (const [syllable, chars] of Object.entries(RAW)) {
  for (const ch of chars) {
    if (!CHAR_TO_PINYIN.has(ch)) {
      CHAR_TO_PINYIN.set(ch, syllable);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert Chinese text to pinyin string (space-separated syllables).
 * Non-Chinese characters (ASCII, punctuation, etc.) pass through as-is.
 *
 * Example:
 *   toPinyin('北京')  → 'bei jing'
 *   toPinyin('Hello北京') → 'Hello bei jing'
 */
export function toPinyin(text: string): string {
  const parts: string[] = [];
  let ascii = '';

  for (const ch of text) {
    const py = CHAR_TO_PINYIN.get(ch);
    if (py !== undefined) {
      if (ascii) {
        parts.push(ascii);
        ascii = '';
      }
      parts.push(py);
    } else {
      ascii += ch;
    }
  }

  if (ascii) {
    parts.push(ascii);
  }

  return parts.join(' ').trim();
}

// ---------------------------------------------------------------------------
// Levenshtein edit distance (on arrays — syllable-level)
// ---------------------------------------------------------------------------
function editDistance(a: string[], b: string[]): number {
  const m = a.length;
  const n = b.length;

  // Use two rows to save memory
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);

  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1];
      } else {
        curr[j] = 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
      }
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n];
}

/**
 * Compute pinyin similarity between two Chinese strings.
 * Returns 0–1 (1.0 = identical pinyin, 0 = completely different).
 * Uses normalized syllable-level Levenshtein distance.
 *
 * Example:
 *   pinyinSimilarity('北京', '北井')  → ~0.5  (bei jing vs bei jing — actually same pinyin!)
 *   pinyinSimilarity('张三', '章三')  → 1.0   (zhang san = zhang san)
 *   pinyinSimilarity('张三', '李四')  → 0.0
 */
export function pinyinSimilarity(a: string, b: string): number {
  if (a === b) return 1;

  const pyA = toPinyin(a);
  const pyB = toPinyin(b);

  if (pyA === pyB) return 1;

  const syllA = pyA.split(/\s+/).filter(Boolean);
  const syllB = pyB.split(/\s+/).filter(Boolean);

  if (syllA.length === 0 && syllB.length === 0) return 1;
  if (syllA.length === 0 || syllB.length === 0) return 0;

  const dist = editDistance(syllA, syllB);
  const maxLen = Math.max(syllA.length, syllB.length);

  return 1 - dist / maxLen;
}
