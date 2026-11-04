import XCTest

final class ChatScrollingUITests: XCTestCase {
    @MainActor
    func testIncomingTextDuringDragDoesNotShiftTheReader() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--chat-scroll-fixture"]
        app.launch()
        XCTAssertTrue(app.staticTexts["End of message 40."].waitForExistence(timeout: 15))
        app.swipeDown()
        app.swipeDown()
        // Track text that remains onscreen after this upward drag. A label
        // at the top may legitimately leave the collection's visible cells.
        let candidate = try XCTUnwrap(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Paragraph '")).allElementsBoundByIndex.first {
            $0.isHittable && $0.frame.minY >= app.frame.height * 0.45
        })
        let reader = app.staticTexts.matching(NSPredicate(format: "label == %@", candidate.label)).firstMatch
        let before = reader.frame.minY
        app.buttons["Stream burst"].tap()
        let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.65))
        let to = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35))
        from.press(forDuration: 0.1, thenDragTo: to, withVelocity: .slow, thenHoldForDuration: 0.5)
        XCTAssertEqual(reader.frame.minY - before, to.screenPoint.y - from.screenPoint.y, accuracy: 20,
                       "Incoming chunks changed the drag distance")
        let settled = reader.frame.minY
        RunLoop.current.run(until: Date().addingTimeInterval(1))
        XCTAssertEqual(reader.frame.minY, settled, accuracy: 1, "Queued chunks moved the reader after the gesture")
    }

    @MainActor
    func testKeyboardKeepsNewestMessageVisible() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--chat-scroll-fixture"]
        app.launch()
        let end = app.staticTexts["End of message 40."]
        XCTAssertTrue(end.waitForExistence(timeout: 15))
        app.textFields["Mock reply"].tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        expectation(for: NSPredicate(format: "hittable == true"), evaluatedWith: end)
        waitForExpectations(timeout: 5)
    }

    @MainActor
    func testIncomingTextFollowsBottomAndPreservesOlderReadingPosition() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--chat-scroll-fixture"]
        app.launch()
        XCTAssertTrue(app.staticTexts["End of message 40."].waitForExistence(timeout: 15))
        for chunk in 1...3 {
            app.buttons["Append reply"].tap()
            let marker = app.staticTexts["Stream chunk \(chunk)."]
            expectation(for: NSPredicate(format: "hittable == true"), evaluatedWith: marker)
            waitForExpectations(timeout: 10)
        }
        app.swipeDown()
        app.swipeDown()
        let candidate = try XCTUnwrap(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Paragraph ' OR label BEGINSWITH 'Incoming text'")).allElementsBoundByIndex.first { $0.isHittable })
        let reader = app.staticTexts.matching(NSPredicate(format: "label == %@", candidate.label)).firstMatch
        let before = reader.frame.minY
        app.buttons["Append reply"].tap()
        RunLoop.current.run(until: Date().addingTimeInterval(1))
        XCTAssertEqual(reader.frame.minY, before, accuracy: 1, "Incoming text pulled the reader away from an older message")
    }

    @MainActor
    func testPaginationPreservesVisibleMessage() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--chat-scroll-fixture"]
        app.launch()
        let end = app.staticTexts["End of message 40."]
        XCTAssertTrue(end.waitForExistence(timeout: 15))
        XCTAssertTrue(end.isHittable, "History must open at the newest message")

        let button = app.buttons["Load earlier messages"]
        let result = app.staticTexts["scroll-position-result"]
        for count in [20, 30, 40] {
            for _ in 0..<35 {
                if button.exists && button.isHittable && button.frame.midY > app.navigationBars.firstMatch.frame.maxY + 8 { break }
                app.swipeDown()
            }
            XCTAssertTrue(button.isHittable)
            button.tap()
            let complete = NSPredicate(format: "label BEGINSWITH %@ AND NOT (label BEGINSWITH 'Loading')", "\(count) messages")
            expectation(for: complete, evaluatedWith: result)
            waitForExpectations(timeout: 10)
            XCTAssertFalse(result.label.contains("FAIL"), result.label)
            let deltaText = try XCTUnwrap(result.label.components(separatedBy: "Δy ").last)
            let delta = try XCTUnwrap(Double(deltaText.replacingOccurrences(of: " pt", with: "")))
            XCTAssertLessThanOrEqual(abs(delta), 1, result.label)
            let attachment = XCTAttachment(screenshot: app.screenshot())
            attachment.name = "After loading \(count) messages"
            attachment.lifetime = .keepAlways
            add(attachment)

            // Cross the newly inserted boundary in both directions. Settling
            // must not move a visible message after the gesture has ended.
            for direction in [true, false, true, false] {
                let seam = app.staticTexts["Message \(51 - count): explain the next change."]
                let seamBefore = seam.frame.minY
                let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: direction ? 0.4 : 0.65))
                let to = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: direction ? 0.65 : 0.4))
                from.press(forDuration: 0.1, thenDragTo: to, withVelocity: .slow, thenHoldForDuration: 0.5)
                // Allow the pan recognition threshold, but reject a layout
                // jump in addition to the actual finger movement.
                XCTAssertEqual(seam.frame.minY - seamBefore, to.screenPoint.y - from.screenPoint.y, accuracy: 20,
                               "The page boundary moved farther than the drag")
                let visible = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Paragraph '")).allElementsBoundByIndex.first { $0.isHittable }
                if let visible {
                    let tracked = app.staticTexts.matching(NSPredicate(format: "label == %@", visible.label)).firstMatch
                    let before = tracked.frame.minY
                    RunLoop.current.run(until: Date().addingTimeInterval(0.5))
                    XCTAssertEqual(tracked.frame.minY, before, accuracy: 1, "A settled row moved at the page boundary")
                }
            }
        }
    }
}
