import XCTest

/// Opt-in live-device test. The private bundle fixture names the exact PC and
/// synthetic notes; unlike the read/write UI checks this test saves and syncs.
final class PCSyncTests: XCTestCase {
    struct Fixture: Decodable {
        let endpoint: String
        let code: String
        let pcTitle: String
        let pcMarker: String
        let phoneTitle: String
        let phoneMarker: String
        let pcUpdateMarker: String
        let attachmentName: String?
        let existingTitle: String
    }
    let app = XCUIApplication(bundleIdentifier: "com.oximemo.mobile")

    func capture(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    func containsText(_ value: String) -> XCUIElement {
        app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", value)).firstMatch
    }

    func tapReady(_ element: XCUIElement) {
        XCTAssertTrue(element.waitForExistence(timeout: 30))
        let enabled = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in element.isEnabled }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [enabled], timeout: 30), .completed)
        element.tap()
    }

    func syncFromLibrary() {
        if app.buttons["취소"].exists { tapReady(app.buttons["취소"]) }
        tapReady(app.buttons["설정"])
        tapReady(app.buttons["PC 연결"])
        syncConnectionAndReturn()
    }

    func syncConnectionAndReturn() {
        let sync = app.buttons["지금 동기화"]
        XCTAssertTrue(sync.waitForExistence(timeout: 30))
        tapReady(sync)
        let finished = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in sync.exists && sync.isEnabled }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [finished], timeout: 40), .completed)
        XCTAssertTrue(containsText("PC와 동기화했어요").waitForExistence(timeout: 30))
        tapReady(app.buttons["설정으로"])
        tapReady(app.buttons["메모 목록으로"])
    }

    func openBySearch(_ title: String) {
        let search = app.searchFields["메모 검색"]
        XCTAssertTrue(search.waitForExistence(timeout: 10))
        XCTAssertEqual(app.state, .runningForeground)
        if app.buttons["검색 지우기"].exists { app.buttons["검색 지우기"].tap() }
        else { search.tap() }
        search.typeText(title)
        let note = app.buttons[title]
        XCTAssertTrue(note.waitForExistence(timeout: 10))
        note.tap()
        XCTAssertTrue(app.staticTexts[title].firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["메모 목록으로"].exists)
    }

    func testPairAndRealRoundTrip() throws {
        continueAfterFailure = false
        guard let path = Bundle(for: Self.self).url(forResource: "SyncFixture", withExtension: "json") else {
            throw XCTSkip("Requires an explicit private live-sync fixture")
        }
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: path))
        XCTAssertTrue(fixture.code.hasPrefix("OM1:"))
        app.launch()
        XCTAssertTrue(app.buttons["설정"].waitForExistence(timeout: 20))
        app.buttons["설정"].tap()
        app.buttons["PC 연결"].tap()
        if app.buttons["지금 동기화"].exists {
            XCTAssertTrue(containsText(fixture.endpoint).exists)
            syncConnectionAndReturn()
        } else {
        // WKWebView exposes the summary and its text child as nested buttons.
        app.buttons["연결 코드 입력"].firstMatch.tap()
        let code = app.textViews["연결 코드"]
        XCTAssertTrue(code.waitForExistence(timeout: 5))
        code.tap()
        code.typeText(fixture.code)
        app.buttons["코드 확인"].tap()
        let connect = app.buttons["이 PC 연결"]
        XCTAssertTrue(connect.waitForExistence(timeout: 10))
        XCTAssertTrue(containsText(fixture.endpoint).exists)
        connect.tap()
        }
        XCTAssertTrue(app.buttons["새 메모 작성"].waitForExistence(timeout: 40))
        capture("physical-paired-library")

        openBySearch(fixture.pcTitle)
        XCTAssertTrue(containsText(fixture.pcMarker).waitForExistence(timeout: 10))
        capture("physical-pc-created-note")
        if let name = fixture.attachmentName {
            tapReady(app.buttons["첨부 · Simulator image"])
            XCTAssertTrue(app.images[name].waitForExistence(timeout: 20))
            capture("simulator-attachment-rendered")
            tapReady(app.buttons["닫기"])
            tapReady(app.buttons["External example · 링크"])
            XCTAssertTrue(XCUIApplication(bundleIdentifier: "com.apple.mobilesafari").wait(for: .runningForeground, timeout: 15))
            app.activate()
            XCTAssertTrue(containsText(fixture.pcMarker).waitForExistence(timeout: 10))
        }
        tapReady(app.buttons["메모 목록으로"])
        openBySearch(fixture.existingTitle)
        capture("physical-existing-pc-note")
        tapReady(app.buttons["메모 목록으로"])

        if app.buttons["취소"].exists { tapReady(app.buttons["취소"]) }
        tapReady(app.buttons["새 메모 작성"])
        let title = app.textViews["메모 제목"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        title.typeText(fixture.phoneTitle + "\n")
        let body = app.textViews["메모 본문"]
        body.typeText("**iPhone to PC**\n\n" + fixture.phoneMarker)
        app.buttons["메모 저장"].tap()
        XCTAssertTrue(app.buttons["편집"].waitForExistence(timeout: 40))
        XCTAssertTrue(containsText(fixture.phoneMarker).exists)
        capture("physical-iphone-created-note")
        tapReady(app.buttons["메모 목록으로"])

        // The host observes the real PC file, verifies the iPhone body, and
        // appends pcUpdateMarker through the digest-guarded PC writer.
        var reflected = false
        for _ in 0..<5 {
            syncFromLibrary()
            openBySearch(fixture.phoneTitle)
            reflected = containsText(fixture.pcUpdateMarker).waitForExistence(timeout: 5)
            if reflected { break }
            tapReady(app.buttons["메모 목록으로"])
        }
        XCTAssertTrue(reflected, "A guarded PC edit must return to the actual iPhone")
        XCTAssertTrue(containsText(fixture.phoneMarker).exists)
        capture("physical-pc-edit-returned-to-iphone")
        tapReady(app.buttons["메모 목록으로"])
    }
}
