"""Extract the offline Oximemo lexicon from the fastText Korean text vectors.

Usage: python3 scripts/build-ko-lexicon.py INPUT.vec.gz OUTPUT_DIR [--tiers]
The default builds the legacy small edition. Pass --tiers with the large
source prefix to also produce both additive vocabularies and full row files.
"""
import gzip
from itertools import islice
import math
from pathlib import Path
import re
import sys
import unicodedata

DIMENSIONS = 300
FREQUENCY_LIMIT = 20000
SCAN_LIMIT = 100000
# Fiction benefits from low-frequency words for atmosphere, motion and voice.
WRITING_WORDS = set('''
고요 고요하다 고즈넉하다 고적하다 아늑하다 서늘하다 스산하다 으스스하다 적막 적요 정적
침묵 쓸쓸하다 고독 외로움 외롭다 처연하다 애틋하다 애달프다 애잔하다 아련하다 그리움
슬프다 서럽다 서글프다 먹먹하다 울컥하다 울먹이다 오열하다 흐느끼다 흐느낌 비탄 우울
울적하다 쓸쓸함 상실감 절망 낙담 허탈 허무 쓸쓸히 비애 서운하다 서운함 섭섭하다
비통하다 한탄 탄식 후회 머쓱하다 겸연쩍다 민망하다 무안하다 멋쩍다 쑥스럽다
평온 평온하다 차분하다 침착하다 담담하다 덤덤하다 담백하다 무덤덤하다 무심하다 무던하다
느긋하다 편안하다 포근하다 따스하다 푸근하다 온화하다 다정하다 살갑다 살뜰하다 정겹다
즐겁다 흐뭇하다 뿌듯하다 황홀하다 벅차다 짜릿하다 흥겹다 들뜨다 설레다 설렘 희열 환희
조바심 초조하다 불안하다 조급하다 안절부절 노심초사 섬뜩하다 소름 공포 기겁하다 경악
놀라다 움찔하다 화들짝 펄쩍 주춤 주춤하다 흠칫 흠칫하다 부들부들 바들바들 부들거리다
날카롭다 매섭다 사납다 매몰차다 매정하다 냉담하다 냉랭하다 단호하다 쌀쌀맞다
중얼거리다 웅얼거리다 속삭이다 속삭임 나직하다 나지막하다 나직이 읊조리다 뇌까리다
되뇌다 되뇌이다 내뱉다 일갈하다 윽박지르다 외치다 소리치다 소곤소곤 수군거리다
버럭 고함 호통 목청 목소리 음성 음색 말씨 어조 어투 비꼬다 빈정거리다 너스레
피식 씨익 빙그레 싱긋 방긋 미소 짓궂다 해맑다 무표정 노려보다 쏘아보다 응시하다
흘깃 힐끗 곁눈질 살피다 훑어보다 훑다 들여다보다 바라보다 내다보다 올려다보다
고개 끄덕이다 갸웃하다 갸웃거리다 기웃거리다 눈짓 몸짓 손짓 움츠리다 웅크리다
머뭇거리다 망설이다 망설임 머뭇머뭇 뒤척이다 비틀거리다 휘청거리다 허둥대다
서성이다 어슬렁거리다 터벅터벅 어기적어기적 종종걸음 뒷걸음 쏜살같이 성큼
살금살금 사뿐사뿐 사뿐히 발걸음 발자국 발소리 걸음걸이 여미다 움켜쥐다 붙들다
스치다 스며들다 배어들다 번지다 퍼지다 피어나다 일렁이다 출렁이다 너울 물결 잔물결
살랑 살랑살랑 산들바람 미풍 돌풍 강풍 해풍 바닷바람 봄바람 칼바람 눈보라
안개 물안개 먹구름 여명 어스름 황혼 저물녘 노을 땅거미 새벽녘 볕 햇볕 햇살
달빛 달무리 별빛 여운 잔향 내음 냄새 향기 향내 향취 비린내 구수하다 매캐하다
고소하다 얼얼하다 알싸하다 새콤하다 쌉싸름하다 시큼하다 톡쏘다 텁텁하다 후끈하다
얼어붙다 얼어들다 뜨끈하다 싸늘하다 미지근하다 축축하다 눅눅하다 메마르다 촉촉하다
아득하다 막막하다 캄캄하다 깜깜하다 희미하다 어렴풋하다 가물가물 선명하다 뚜렷하다
아스라하다 뿌옇다 흐릿하다 아찔하다 현기증 어지럽다 아른거리다 깜빡거리다
반짝이다 반짝반짝 번뜩이다 반들반들 얼룩 울퉁불퉁 거칠다 까칠하다 보드랍다
바삭하다 말랑하다 단단하다 질척하다 미끈하다 미끄럽다 서걱거리다 사각사각
바스락 바스락거리다 부스럭 소곤소곤 바람결 물소리 빗소리 파도소리 파도 포말
쿵쿵 똑딱 삐걱 삐걱거리다 덜컥 달그락 쩌렁쩌렁 쨍그랑 조용하다 잠잠하다
구석 모퉁이 골목 골목길 언덕 고갯길 오솔길 산책로 들판 벌판 능선 산자락 숲길
산그늘 나뭇잎 풀잎 풀벌레 개울 시냇물 자갈 모래사장 물가 강가 바닷가 파문
문틈 창틀 창턱 유리창 문고리 미닫이 처마 마루 툇마루 마당 돌담 뜰 한낮 한밤중
서랍 주머니 손바닥 손등 손끝 눈꺼풀 눈가 눈썹 뒷모습 그림자 자국 흔적
'''.split())
SYLLABLE_WORDS = set("값 강 겁 겉 곁 곳 곡 귀 길 꿈 꽃 낯 낮 눈 달 닭 땅 땀 떡 뜻 말 맛 맘 몸 물 문 밤 밥 방 배 벌 벽 별 봄 불 빛 뿔 산 살 새 섬 손 숲 숨 술 시 신 쌀 썰 알 앞 약 양 옷 왕 용 원 잎 잠 장 줄 집 짐 차 창 책 철 춤 층 칼 코 콩 탈 털 틈 팔 피 해 혀 힘 흙".split())
HANGUL = re.compile(r"[가-힣]{2,12}\Z")


def source_rows(path, limit):
    with gzip.open(path, "rb") as source:
        if next(source).split() != [b"2000000", b"300"]:
            raise ValueError("Unexpected fastText vector dimensions")
        for line in islice(source, limit):
            word, _, row = line.partition(b" ")
            word = unicodedata.normalize("NFC", word.decode("utf-8", "replace"))
            if HANGUL.fullmatch(word) or word in SYLLABLE_WORDS:
                yield word, row


def quantize(row):
    vector = [float(value) for value in row.split()]
    if len(vector) != DIMENSIONS or not all(map(math.isfinite, vector)):
        raise ValueError("Invalid fastText vector")
    peak = max(map(abs, vector))
    if not peak:
        raise ValueError("Empty fastText vector")
    return bytes(round(value / peak * 127) & 255 for value in vector)


def small_edition(path):
    words = {}
    for word, row in source_rows(path, SCAN_LIMIT):
        if word not in words and (len(words) < FREQUENCY_LIMIT or word in WRITING_WORDS):
            words[word] = quantize(row)
    if len(words) != 20_056:
        raise ValueError("Unexpected small edition")
    return words


def extension(path, previous, count, scan_rows):
    ranked = dict.fromkeys(word for word, _ in source_rows(path, scan_rows) if word not in previous)
    priority = [word for word in ranked if word in WRITING_WORDS]
    common = (word for word in ranked if word not in WRITING_WORDS)
    extra = priority + list(islice(common, count - len(previous) - len(priority)))
    wanted = set(extra)
    if len(extra) != count - len(previous):
        raise ValueError("Incomplete source")
    vectors = {}
    for word, row in source_rows(path, scan_rows):
        if word in wanted:
            vectors[word] = quantize(row)
            wanted.remove(word)
    return {word: vectors[word] for word in extra}


def main():
    source, output = Path(sys.argv[1]), Path(sys.argv[2])
    output.mkdir(parents=True, exist_ok=True)
    words = small_edition(source)
    (output / "words.txt").write_bytes(("\n".join(words) + "\n").encode())
    (output / "vectors.bin").write_bytes(b"".join(words.values()))
    if "--tiers" in sys.argv[3:]:
        for name, count, scan_rows in [("medium", 60_000, 200_000), ("large", 200_000, 500_000)]:
            extra = extension(source, words, count, scan_rows)
            (output / f"words-{name}.txt").write_bytes(("\n".join(extra) + "\n").encode())
            words.update(extra)
            (output / f"vectors-{name}.bin").write_bytes(b"".join(words.values()))
            print(name, len(words), "writing terms", len(words.keys() & WRITING_WORDS), flush=True)


if __name__ == "__main__":
    main()
